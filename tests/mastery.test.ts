import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CurriculumGraph } from "../src/curriculum.js";
import type { CurriculumObjective } from "../src/curriculum.js";
import { LearningEventStore } from "../src/learning-event.js";
import type { LearningEvent, LearningEventInput } from "../src/learning-event.js";
import { computeMastery, createIsSatisfied } from "../src/mastery.js";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function ev(partial: Partial<LearningEvent> & Pick<LearningEvent, "outcome">): LearningEvent {
  return {
    id: "e",
    entityId: "gh:1",
    sessionId: "s1",
    track: "rust",
    objectiveId: "obj-a",
    bloomLevel: "apply",
    exchangeType: "socratic",
    source: "chat_answer",
    hintTierReached: 0,
    timestamp: NOW,
    ...partial,
  };
}

describe("computeMastery", () => {
  test("no events -> 0", () => {
    expect(computeMastery([])).toBe(0);
  });

  test("a single independent_success at hint tier 0 -> full evidence, close to 1", () => {
    const score = computeMastery([ev({ outcome: "independent_success", hintTierReached: 0, timestamp: NOW })], { now: NOW });
    expect(score).toBeCloseTo(1.0, 5);
  });

  test("assisted_success is discounted more heavily at higher hint tiers", () => {
    const tier1 = computeMastery([ev({ outcome: "assisted_success", hintTierReached: 1, timestamp: NOW })], { now: NOW });
    const tier2 = computeMastery([ev({ outcome: "assisted_success", hintTierReached: 2, timestamp: NOW })], { now: NOW });
    const tier3 = computeMastery([ev({ outcome: "assisted_success", hintTierReached: 3, timestamp: NOW })], { now: NOW });
    expect(tier1).toBeGreaterThan(tier2);
    expect(tier2).toBeGreaterThan(tier3);
    // a tier-3 assisted "success" should never read as anywhere near mastered on its own
    expect(tier3).toBeLessThan(0.3);
  });

  test("failure contributes real (negative) evidence, pulling the estimate down", () => {
    const oneSuccess = computeMastery([ev({ outcome: "independent_success", timestamp: NOW })], { now: NOW });
    const successThenFailure = computeMastery(
      [ev({ outcome: "independent_success", timestamp: NOW }), ev({ outcome: "failure", timestamp: NOW })],
      { now: NOW }
    );
    expect(successThenFailure).toBeLessThan(oneSuccess);
  });

  test("abandoned events are excluded entirely - neither help nor hurt", () => {
    const withoutAbandoned = computeMastery([ev({ outcome: "independent_success", timestamp: NOW })], { now: NOW });
    const withAbandoned = computeMastery(
      [ev({ outcome: "independent_success", timestamp: NOW }), ev({ outcome: "abandoned", timestamp: NOW })],
      { now: NOW }
    );
    expect(withAbandoned).toBe(withoutAbandoned);
  });

  test("older evidence counts for less relative to newer evidence, given both", () => {
    // A single isolated event's P(know) doesn't decay toward 0 in a vacuum - decay only
    // matters relative to OTHER evidence, since this is a normalized weighted average, not a
    // raw decaying score (see this file's own doc comment: mastery reflects the balance of
    // evidence, not "how long ago was the last check-in" - that's a separate, not-yet-built
    // spaced-review mechanism that reuses this same decay curve for a different purpose).
    // So: pair a fixed fresh failure with a success at two different ages and confirm the
    // OLDER success is outweighed by the fresh failure more than the RECENT success is.
    const freshFailure = () => ev({ outcome: "failure", timestamp: NOW });
    const recentPairedWithFreshFailure = computeMastery(
      [ev({ outcome: "independent_success", timestamp: NOW }), freshFailure()],
      { now: NOW, halfLifeMs: 14 * DAY }
    );
    const stalePairedWithFreshFailure = computeMastery(
      [ev({ outcome: "independent_success", timestamp: NOW - 60 * DAY }), freshFailure()],
      { now: NOW, halfLifeMs: 14 * DAY }
    );
    expect(stalePairedWithFreshFailure).toBeLessThan(recentPairedWithFreshFailure);
  });

  test("a mix of a stale failure and a fresh independent_success favors the fresh evidence", () => {
    const score = computeMastery(
      [
        ev({ outcome: "failure", timestamp: NOW - 90 * DAY }),
        ev({ outcome: "independent_success", timestamp: NOW }),
      ],
      { now: NOW, halfLifeMs: 14 * DAY }
    );
    // the 90-day-old failure has decayed to near-nothing relative to the fresh success
    expect(score).toBeGreaterThan(0.9);
  });

  test("repeated independent successes converge toward 1, not accumulate past it", () => {
    const events = Array.from({ length: 5 }, () => ev({ outcome: "independent_success", timestamp: NOW }));
    expect(computeMastery(events, { now: NOW })).toBeCloseTo(1.0, 5);
  });
});

describe("createIsSatisfied", () => {
  let dir: string;
  let store: LearningEventStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "cads-mastery-test-"));
    store = new LearningEventStore(path.join(dir, "events.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function record(input: Omit<LearningEventInput, "entityId" | "sessionId" | "track"> & { entityId?: string }, ts: number) {
    store.record(
      { entityId: "gh:1", sessionId: "s1", track: "rust", ...input },
      ts
    );
  }

  test("false with no events for that objective", () => {
    const isSatisfied = createIsSatisfied(store, "gh:1", { now: NOW });
    expect(isSatisfied("obj-a")).toBe(false);
  });

  test("true once real independent successes cross the threshold", () => {
    record({ objectiveId: "obj-a", bloomLevel: "apply", exchangeType: "socratic", source: "chat_answer", hintTierReached: 0, outcome: "independent_success" }, NOW);
    const isSatisfied = createIsSatisfied(store, "gh:1", { now: NOW });
    expect(isSatisfied("obj-a")).toBe(true);
  });

  test("false when the only evidence is a heavily-hinted success", () => {
    record({ objectiveId: "obj-a", bloomLevel: "apply", exchangeType: "socratic", source: "chat_answer", hintTierReached: 3, outcome: "assisted_success" }, NOW);
    const isSatisfied = createIsSatisfied(store, "gh:1", { now: NOW });
    expect(isSatisfied("obj-a")).toBe(false);
  });

  test("is scoped per-student - another student's events never leak in", () => {
    record({ entityId: "gh:2", objectiveId: "obj-a", bloomLevel: "apply", exchangeType: "socratic", source: "chat_answer", hintTierReached: 0, outcome: "independent_success" }, NOW);
    const isSatisfied = createIsSatisfied(store, "gh:1", { now: NOW });
    expect(isSatisfied("obj-a")).toBe(false);
  });

  test("wired directly into CurriculumGraph.computeFrontier - the real integration point", () => {
    const objectives: CurriculumObjective[] = [
      { id: "a", track: "rust", unitId: "a", bloomLevel: "understand", statement: "s", sourceDocIds: ["d1"], prerequisiteObjectiveIds: [] },
      { id: "b", track: "rust", unitId: "b", bloomLevel: "apply", statement: "s", sourceDocIds: ["d2"], prerequisiteObjectiveIds: ["a"] },
    ];
    const graph = new CurriculumGraph(objectives);
    const isSatisfied = createIsSatisfied(store, "gh:1", { now: NOW });

    expect(graph.computeFrontier("rust", isSatisfied).map((o) => o.id)).toEqual(["a"]);

    record({ objectiveId: "a", bloomLevel: "understand", exchangeType: null, source: "chat_answer", hintTierReached: 0, outcome: "independent_success" }, NOW);
    const isSatisfiedAfter = createIsSatisfied(store, "gh:1", { now: NOW });
    expect(graph.computeFrontier("rust", isSatisfiedAfter).map((o) => o.id)).toEqual(["b"]);
  });
});
