import type { BloomPromptMode } from "./bloom.js";
import { buildTutorPrompt } from "./bloom.js";
import type { CurriculumGraph } from "./curriculum.js";
import type { GroundingEngine } from "./ground.js";
import type { LearningEventStore } from "./learning-event.js";
import { createIsSatisfied } from "./mastery.js";
import type { BloomLevel, RetrievedChunk } from "./types.js";

/**
 * The Proactive Tutor Roadmap's Phase A mechanism #3: "at the end of any turn, code - not the
 * LLM - picks the next-best objective ... and the LLM only phrases the offer." This type IS
 * that pick: structured data, not LLM prose. A caller (the VS Code extension's webview, the
 * `tutor` CLI) decides how - or whether - to phrase it; TutorSession's job stops at selecting
 * the objective, which is the actual trust-boundary-sensitive part per the roadmap's own note
 * ("unprompted is not a license to skip retrieval" applies just as much to skipping the
 * curriculum graph in favor of an LLM guess).
 */
export interface NextSuggestion {
  objectiveId: string;
  statement: string;
  bloomLevel: BloomLevel;
}

export type TutorTurnResult =
  | { kind: "refused"; reason: string }
  | { kind: "llm-error"; citations: RetrievedChunk[]; message: string }
  | {
      kind: "answer";
      text: string;
      citations: RetrievedChunk[];
      mode: BloomPromptMode;
      bloomLevel: BloomLevel;
      hintTier: number;
      /** null when curriculum/learningEvents/track weren't supplied to the constructor (the
       * feature is opt-in - see TutorSessionOptions), or when nothing is currently legal to
       * suggest (frontier empty: everything unlocked so far is mastered, or nothing's unlocked
       * yet with no root reachable, which `computeFrontier`'s own construction-time checks
       * already rule out for a well-formed graph). */
      nextSuggestion: NextSuggestion | null;
    };

export interface AskOptions {
  bloomLevel?: BloomLevel;
  attemptNumber?: number;
}

export interface Explainer {
  complete(prompt: string): Promise<string>;
}

export interface InteractionRecorder {
  recordInteraction(studentId: string, text: string, metadata?: Record<string, unknown>): Promise<void>;
}

/** Opt-in: TutorSession works exactly as before with none of these supplied - nextSuggestion is
 * simply always null. All three are required together for the feature to activate, since a
 * frontier query is meaningless without a graph, a mastery estimate, and a track to scope it
 * to. */
export interface TutorSessionOptions {
  curriculum?: CurriculumGraph;
  learningEvents?: LearningEventStore;
  track?: string;
}

/**
 * Orchestrates one student turn across GroundingEngine, an Explainer (the
 * LLM), and an InteractionRecorder (dialog memory) - without letting either
 * of the latter two run on a path where they shouldn't: an ungrounded
 * question never reaches the LLM, and a failed LLM call never gets recorded
 * as a real interaction.
 */
export class TutorSession {
  private readonly curriculum?: CurriculumGraph;
  private readonly learningEvents?: LearningEventStore;
  private readonly track?: string;

  constructor(
    private readonly engine: GroundingEngine,
    private readonly llm: Explainer,
    private readonly memory: InteractionRecorder,
    options: TutorSessionOptions = {}
  ) {
    this.curriculum = options.curriculum;
    this.learningEvents = options.learningEvents;
    this.track = options.track;
  }

  async ask(studentId: string, query: string, options: AskOptions = {}): Promise<TutorTurnResult> {
    const answer = this.engine.ask(query);
    if (!answer.grounded) {
      return { kind: "refused", reason: answer.refusalReason! };
    }

    const { prompt, mode, bloomLevel, hintTier } = buildTutorPrompt(this.engine, query, answer, options);

    let text: string;
    try {
      text = await this.llm.complete(prompt);
    } catch (err) {
      return {
        kind: "llm-error",
        citations: answer.citations,
        message: err instanceof Error ? err.message : String(err),
      };
    }

    try {
      await this.memory.recordInteraction(studentId, text, {
        query,
        citedChunkIds: answer.citations.map((c) => c.chunk.id),
        bloomLevel,
        mode,
        hintTier,
      });
    } catch (err) {
      console.warn("TutorSession: failed to record interaction", err);
    }

    const nextSuggestion = this.computeNextSuggestion(studentId);
    return { kind: "answer", text, citations: answer.citations, mode, bloomLevel, hintTier, nextSuggestion };
  }

  /** Deterministic, code-only selection - see NextSuggestion's own doc comment for why this
   * must never be delegated to the LLM. Picks the first objective computeFrontier returns for
   * this student's track; CurriculumGraph.all() (and therefore computeFrontier's filter over
   * it) preserves the order objectives were loaded in, which for the generated content-packs is
   * already each track's authored pedagogical sequence - see gen-curriculum.py. */
  private computeNextSuggestion(studentId: string): NextSuggestion | null {
    if (!this.curriculum || !this.learningEvents || !this.track) return null;
    const isSatisfied = createIsSatisfied(this.learningEvents, studentId);
    const frontier = this.curriculum.computeFrontier(this.track, isSatisfied);
    if (frontier.length === 0) return null;
    const next = frontier[0];
    return { objectiveId: next.id, statement: next.statement, bloomLevel: next.bloomLevel };
  }
}
