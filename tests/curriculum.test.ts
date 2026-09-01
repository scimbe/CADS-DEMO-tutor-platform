import { CurriculumGraph } from "../src/curriculum.js";
import type { CurriculumObjective } from "../src/curriculum.js";

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
