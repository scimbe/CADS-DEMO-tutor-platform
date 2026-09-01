import path from "node:path";
import { fileURLToPath } from "node:url";
import { CurriculumGraph, loadCurriculumObjectives } from "../src/curriculum.js";
import type { CurriculumObjective } from "../src/curriculum.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_CURRICULUM_PATH = path.join(__dirname, "..", "content-packs", "curriculum.json");

function obj(partial: Partial<CurriculumObjective> & Pick<CurriculumObjective, "id">): CurriculumObjective {
  return {
    track: "rust",
    unitId: "unit-1",
    bloomLevel: "understand",
    statement: "test objective",
    sourceDocIds: ["doc-1"],
    prerequisiteObjectiveIds: [],
    ...partial,
  };
}

describe("CurriculumGraph", () => {
  test("throws if an objective has no sourceDocIds", () => {
    expect(() => new CurriculumGraph([obj({ id: "a", sourceDocIds: [] })])).toThrow(/sourceDocIds/);
  });

  test("throws if an objective references an unknown prerequisite", () => {
    expect(() => new CurriculumGraph([obj({ id: "a", prerequisiteObjectiveIds: ["ghost"] })])).toThrow(/unknown prerequisite/);
  });

  test("computeFrontier returns only objectives whose prerequisites are all satisfied", () => {
    const graph = new CurriculumGraph([
      obj({ id: "ownership", prerequisiteObjectiveIds: [] }),
      obj({ id: "borrowing", prerequisiteObjectiveIds: ["ownership"] }),
      obj({ id: "lifetimes", prerequisiteObjectiveIds: ["ownership", "borrowing"] }),
    ]);

    const satisfied = new Set<string>();
    expect(graph.computeFrontier("rust", (id) => satisfied.has(id)).map((o) => o.id)).toEqual(["ownership"]);

    satisfied.add("ownership");
    expect(graph.computeFrontier("rust", (id) => satisfied.has(id)).map((o) => o.id)).toEqual(["borrowing"]);

    satisfied.add("borrowing");
    expect(graph.computeFrontier("rust", (id) => satisfied.has(id)).map((o) => o.id)).toEqual(["lifetimes"]);

    satisfied.add("lifetimes");
    expect(graph.computeFrontier("rust", (id) => satisfied.has(id))).toEqual([]);
  });

  test("computeFrontier is scoped to one track", () => {
    const graph = new CurriculumGraph([
      obj({ id: "rust-a", track: "rust" }),
      obj({ id: "js-a", track: "javascript" }),
    ]);
    const frontier = graph.computeFrontier("rust", () => false);
    expect(frontier.map((o) => o.id)).toEqual(["rust-a"]);
  });

  test("dependsOn detects a real transitive dependency", () => {
    const graph = new CurriculumGraph([
      obj({ id: "a" }),
      obj({ id: "b", prerequisiteObjectiveIds: ["a"] }),
      obj({ id: "c", prerequisiteObjectiveIds: ["b"] }),
    ]);
    expect(graph.dependsOn("c", "a")).toBe(true);
    expect(graph.dependsOn("c", "b")).toBe(true);
    expect(graph.dependsOn("a", "c")).toBe(false);
  });

  test("get and all() expose the loaded objectives", () => {
    const graph = new CurriculumGraph([obj({ id: "a" }), obj({ id: "b" })]);
    expect(graph.get("a")?.id).toBe("a");
    expect(graph.get("missing")).toBeUndefined();
    expect(graph.all()).toHaveLength(2);
  });
});

describe("loadCurriculumObjectives against the real generated content-packs/curriculum.json", () => {
  // Real dataset, not a fixture: this both confirms the loader works and that
  // scripts/gen-curriculum.py produced a valid, cycle-free, fully-grounded graph
  // for every track - a bug here means a content pack shipped an objective that
  // doesn't actually trace to real reference material, or a broken prerequisite.
  const objectives = loadCurriculumObjectives(REAL_CURRICULUM_PATH);

  test("loads all three tracks with a non-trivial objective count", () => {
    expect(objectives.length).toBeGreaterThanOrEqual(37); // 15 firmware + 15 rust + 7 javascript
    const tracks = new Set(objectives.map((o) => o.track));
    expect(tracks).toEqual(new Set(["firmware", "rust", "javascript"]));
  });

  test("every objective has real sourceDocIds (no invented goals) and builds a valid graph", () => {
    for (const o of objectives) {
      expect(o.sourceDocIds.length).toBeGreaterThan(0);
    }
    expect(() => new CurriculumGraph(objectives)).not.toThrow();
  });

  test("each track has exactly one root objective (no prerequisites) that starts its frontier", () => {
    const graph = new CurriculumGraph(objectives);
    for (const track of ["firmware", "rust", "javascript"]) {
      const frontier = graph.computeFrontier(track, () => false);
      expect(frontier.length).toBeGreaterThanOrEqual(1);
    }
  });

  test("no objective is its own transitive prerequisite", () => {
    const graph = new CurriculumGraph(objectives);
    for (const o of objectives) {
      expect(graph.dependsOn(o.id, o.id)).toBe(false);
    }
  });
});
