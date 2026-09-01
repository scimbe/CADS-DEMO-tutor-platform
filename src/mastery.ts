import type { LearningEvent, LearningEventOutcome, LearningEventStore } from "./learning-event.js";

/**
 * Turns `computeFrontier`'s caller-injected `isSatisfied` stub into the actual mechanism the
 * backbone architecture was built around - see the Phase A roadmap's mechanism #1. Every other
 * proactive/adaptive mechanism in that roadmap (spaced re-checks, the turn-end suggestion, the
 * Frontier Map, self-explanation gating) reads or writes the estimate this file computes, so
 * this is deliberately the first piece built, not a parallel feature.
 *
 * A pure function over `LearningEventStore` rows, not a model: P(know) is a recency-weighted,
 * hint-tier-discounted AVERAGE of each event's evidence score, never an LLM judgment - the
 * classifier stays deterministic per the roadmap's own trust-boundary note. Because it's a
 * normalized average, not a raw decaying score, a single isolated success doesn't fade toward 0
 * just from the passage of time with no new evidence either way - decay only changes how much
 * older evidence counts RELATIVE TO newer evidence when both exist (see the test file's own note
 * on this - it tripped up the first draft of these tests too). Whether a long-mastered-but-untouched
 * objective should actively be flagged for review is a separate, not-yet-built mechanism (the
 * roadmap's spaced re-checks, #2) that reuses this same decay curve for a different purpose:
 * scheduling a review, not un-gating progression that already happened.
 *
 * The other knob: how strongly a hint-assisted "success" counts as real evidence of mastery (a
 * hint-3 answer is much weaker evidence than an unaided one - Bloom's "cued elaboration"
 * ingredient says the *unassisted* recall is what predicts real transfer).
 */

/** independent_success/assisted_success/failure/abandoned/partial -> how much evidence-of-mastery
 * one occurrence provides, before hint-tier discounting and recency decay. `abandoned` is
 * deliberately excluded downstream (no evidence either way, not "evidence of not knowing") - see
 * `isMasteryEvidence`. */
const OUTCOME_SCORE: Record<LearningEventOutcome, number> = {
  independent_success: 1.0,
  assisted_success: 1.0, // discounted per-event by hint tier below - see hintTierDiscount
  partial: 0.3,
  failure: 0.0,
  abandoned: 0.0, // never reached: filtered out by isMasteryEvidence before scoring
};

/** hintTierReached 0 (no ladder involved, or independent) through 3 (heaviest scaffold). A
 * tier-3 "assisted_success" is treated as roughly a quarter as strong evidence as an unaided
 * one - see this file's own doc comment on why cued vs. independent recall aren't equal
 * evidence. */
const HINT_TIER_DISCOUNT = [1.0, 0.7, 0.45, 0.2] as const;

function isMasteryEvidence(event: LearningEvent): boolean {
  return event.outcome !== "abandoned";
}

function evidenceScore(event: LearningEvent): number {
  const base = OUTCOME_SCORE[event.outcome];
  if (event.outcome !== "assisted_success") return base;
  const tier = Math.min(Math.max(event.hintTierReached, 0), HINT_TIER_DISCOUNT.length - 1);
  return base * HINT_TIER_DISCOUNT[tier];
}

export interface MasteryOptions {
  /** Half-life of an event's contribution to the estimate, in milliseconds. Default 14 days:
   * chosen so a burst of practice from two weeks ago still counts for something but a single
   * old success can't indefinitely gate a downstream objective closed to review. */
  halfLifeMs?: number;
  /** P(know) at or above this counts as mastered. Default 0.85, matching the roadmap doc's own
   * proposed threshold - deliberately high, since this gates real curriculum progression, not
   * just a display metric. */
  masteryThreshold?: number;
  /** Injectable clock for deterministic tests - see learning-event.ts's own `now` parameter for
   * the same pattern. */
  now?: number;
}

const DEFAULT_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_MASTERY_THRESHOLD = 0.85;

/**
 * Recency-weighted, hint-tier-discounted P(know) in [0, 1] for one (student, objective) pair,
 * from already-filtered events (typically the result of `LearningEventStore.query({ entityId,
 * objectiveId })`). Returns 0 for no qualifying evidence - an objective with no attempts is not
 * mastered, not an error (unlike `CurriculumObjective.sourceDocIds` being empty, which the
 * curriculum graph does treat as a construction-time bug - this is normal, expected state for
 * an objective a student hasn't reached yet).
 */
export function computeMastery(events: readonly LearningEvent[], options: MasteryOptions = {}): number {
  const halfLifeMs = options.halfLifeMs ?? DEFAULT_HALF_LIFE_MS;
  const now = options.now ?? Date.now();

  let weightedScoreSum = 0;
  let weightSum = 0;
  for (const event of events) {
    if (!isMasteryEvidence(event)) continue;
    const ageMs = Math.max(0, now - event.timestamp);
    const recencyWeight = Math.pow(0.5, ageMs / halfLifeMs);
    weightedScoreSum += recencyWeight * evidenceScore(event);
    weightSum += recencyWeight;
  }

  if (weightSum === 0) return 0;
  return weightedScoreSum / weightSum;
}

/**
 * Builds the `isSatisfied` predicate `CurriculumGraph.computeFrontier(track, isSatisfied)`
 * expects, backed by real events for one student instead of a caller-injected stub. One query
 * per objective (LearningEventStore is indexed on (entityId, objectiveId) precisely for this
 * access pattern) - fine for a frontier check's objective count; revisit with a batch query if
 * this ever runs over the full graph rather than one track's frontier.
 */
export function createIsSatisfied(
  store: LearningEventStore,
  entityId: string,
  options: MasteryOptions = {}
): (objectiveId: string) => boolean {
  const threshold = options.masteryThreshold ?? DEFAULT_MASTERY_THRESHOLD;
  return (objectiveId: string): boolean => {
    const events = store.query({ entityId, objectiveId });
    return computeMastery(events, options) >= threshold;
  };
}
