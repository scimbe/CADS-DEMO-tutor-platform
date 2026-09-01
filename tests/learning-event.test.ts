import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LearningEventStore } from "../src/learning-event.js";

describe("LearningEventStore", () => {
  let dir: string;
  let store: LearningEventStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "cads-learning-event-test-"));
    store = new LearningEventStore(path.join(dir, "events.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("records an event and assigns a real id and timestamp", () => {
    const event = store.record(
      {
        entityId: "gh:1",
        sessionId: "sess-1",
        track: "rust",
        objectiveId: "ownership-basics",
        bloomLevel: "apply",
        exchangeType: "socratic",
        source: "chat_answer",
        hintTierReached: 1,
        outcome: "independent_success",
      },
      1_700_000_000_000
    );

    expect(event.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(event.timestamp).toBe(1_700_000_000_000);
  });

  test("query filters by entityId, track, and objectiveId", () => {
    store.record({ entityId: "gh:1", sessionId: "s1", track: "rust", objectiveId: "obj-a", bloomLevel: "apply", exchangeType: "socratic", source: "chat_answer", hintTierReached: 0, outcome: "independent_success" }, 100);
    store.record({ entityId: "gh:1", sessionId: "s1", track: "rust", objectiveId: "obj-b", bloomLevel: "apply", exchangeType: "socratic", source: "chat_answer", hintTierReached: 0, outcome: "independent_success" }, 200);
    store.record({ entityId: "gh:2", sessionId: "s2", track: "rust", objectiveId: "obj-a", bloomLevel: "apply", exchangeType: "socratic", source: "chat_answer", hintTierReached: 0, outcome: "independent_success" }, 300);
    store.record({ entityId: "gh:1", sessionId: "s1", track: "firmware", objectiveId: "obj-c", bloomLevel: "apply", exchangeType: "socratic", source: "chat_answer", hintTierReached: 0, outcome: "independent_success" }, 400);

    expect(store.query({ entityId: "gh:1" })).toHaveLength(3);
    expect(store.query({ entityId: "gh:1", track: "rust" })).toHaveLength(2);
    expect(store.query({ entityId: "gh:1", objectiveId: "obj-a" })).toHaveLength(1);
    expect(store.query({})).toHaveLength(4);
  });

  test("query returns oldest first and respects since", () => {
    store.record({ entityId: "gh:1", sessionId: "s1", track: "rust", bloomLevel: "remember", exchangeType: "explain", source: "chat_answer", hintTierReached: 0, outcome: "independent_success" }, 100);
    store.record({ entityId: "gh:1", sessionId: "s1", track: "rust", bloomLevel: "remember", exchangeType: "explain", source: "chat_answer", hintTierReached: 0, outcome: "independent_success" }, 300);
    store.record({ entityId: "gh:1", sessionId: "s1", track: "rust", bloomLevel: "remember", exchangeType: "explain", source: "chat_answer", hintTierReached: 0, outcome: "independent_success" }, 200);

    const all = store.query({ entityId: "gh:1" });
    expect(all.map((e) => e.timestamp)).toEqual([100, 200, 300]);

    const since200 = store.query({ entityId: "gh:1", since: 200 });
    expect(since200.map((e) => e.timestamp)).toEqual([200, 300]);
  });

  test("never overwrites - two events for the same objective both persist", () => {
    store.record({ entityId: "gh:1", sessionId: "s1", track: "rust", objectiveId: "obj-a", bloomLevel: "apply", exchangeType: "socratic", source: "chat_answer", hintTierReached: 2, outcome: "assisted_success" }, 100);
    store.record({ entityId: "gh:1", sessionId: "s2", track: "rust", objectiveId: "obj-a", bloomLevel: "apply", exchangeType: "socratic", source: "chat_answer", hintTierReached: 0, outcome: "independent_success" }, 200);

    const events = store.query({ entityId: "gh:1", objectiveId: "obj-a" });
    expect(events).toHaveLength(2);
    expect(events[0].outcome).toBe("assisted_success");
    expect(events[1].outcome).toBe("independent_success");
  });

  test("groundingDocIds round-trips through JSON storage", () => {
    store.record({ entityId: "gh:1", sessionId: "s1", track: "rust", bloomLevel: "understand", exchangeType: "explain", source: "chat_answer", hintTierReached: 0, outcome: "independent_success", groundingDocIds: ["doc-1", "doc-2"] }, 100);
    const [event] = store.query({ entityId: "gh:1" });
    expect(event.groundingDocIds).toEqual(["doc-1", "doc-2"]);
  });

  test("persists to disk across store instances", () => {
    const dbPath = path.join(dir, "persisted.db");
    const first = new LearningEventStore(dbPath);
    first.record({ entityId: "gh:1", sessionId: "s1", track: "rust", bloomLevel: "remember", exchangeType: "explain", source: "chat_answer", hintTierReached: 0, outcome: "independent_success" }, 100);
    first.close();

    const second = new LearningEventStore(dbPath);
    expect(second.query({ entityId: "gh:1" })).toHaveLength(1);
    second.close();
  });
});
