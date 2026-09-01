import type { BloomLevel } from "./types.js";

/**
 * The one authoritative progression graph, per the backbone architecture's synthesis: two
 * independently-proposed DAGs (a gamification-first unit tree and a mastery-first objective
 * graph) would drift the first time someone edited one and forgot the other, so this is the
 * only place prerequisite edges are hand-authored. A skill-tree/chapter view is a display
 * layer computed from this, never a second authored graph.
 *
 * An objective with no source_doc_ids is a bug, not a valid entry: it means a goal was typed
 * instead of derived from the licensed reference material this whole platform's non-negotiable
 * rule requires - see ground.ts's GroundingEngine docstring. Enforced by the type, not just a
 * comment: sourceDocIds is required, not optional.
 */
export interface CurriculumObjective {
  id: string;
  track: string;
  unitId: string;
  bloomLevel: BloomLevel;
  statement: string;
  sourceDocIds: string[];
  prerequisiteObjectiveIds: string[];
}

export class CurriculumGraph {
  private readonly byId = new Map<string, CurriculumObjective>();

  constructor(objectives: CurriculumObjective[]) {
    for (const o of objectives) {
      if (o.sourceDocIds.length === 0) {
        throw new Error(`CurriculumObjective "${o.id}" has no sourceDocIds - every objective must trace to real reference material, never an invented goal.`);
      }
      this.byId.set(o.id, o);
    }
    for (const o of objectives) {
      for (const prereqId of o.prerequisiteObjectiveIds) {
        if (!this.byId.has(prereqId)) {
          throw new Error(`CurriculumObjective "${o.id}" lists unknown prerequisite "${prereqId}".`);
        }
      }
    }
  }

  get(objectiveId: string): CurriculumObjective | undefined {
    return this.byId.get(objectiveId);
  }

  all(): CurriculumObjective[] {
    return [...this.byId.values()];
  }

  /**
   * The frontier: objectives whose prerequisites are ALL satisfied (per `isSatisfied`, injected
   * so this stays testable without a real mastery store - Phase 2 will pass
   * student_objective_mastery's real proficiency check here) and whose own state isn't already
   * satisfied. This is the candidate set a check-in dialog's goal-generation step is allowed to
   * offer the LLM to phrase - never a wider set, per the architecture doc's own "the LLM only
   * phrases, never picks the goal" trust boundary.
   */
  computeFrontier(track: string, isSatisfied: (objectiveId: string) => boolean): CurriculumObjective[] {
    return this.all().filter((o) => {
      if (o.track !== track) return false;
      if (isSatisfied(o.id)) return false;
      return o.prerequisiteObjectiveIds.every((prereqId) => isSatisfied(prereqId));
    });
  }

  /** True if `objectiveId` (transitively) depends on `possibleAncestorId` - useful for
   * validating that a proposed edge doesn't create a cycle before it's authored. */
  dependsOn(objectiveId: string, possibleAncestorId: string, seen = new Set<string>()): boolean {
    if (seen.has(objectiveId)) return false; // already-visited guard against a cycle already present
    seen.add(objectiveId);
    const o = this.byId.get(objectiveId);
    if (!o) return false;
    if (o.prerequisiteObjectiveIds.includes(possibleAncestorId)) return true;
    return o.prerequisiteObjectiveIds.some((p) => this.dependsOn(p, possibleAncestorId, seen));
  }
}
