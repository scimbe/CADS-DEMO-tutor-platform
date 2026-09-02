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

/** Cap on how much code a check-in prompt embeds. Not a hard technical limit - a sane default
 * against a runaway file blowing up prompt cost; a caller wanting more control should send a
 * relevant excerpt (the function being worked on) rather than an entire file anyway. */
const CHECKIN_CODE_CONTEXT_MAX_CHARS = 6000;

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

  /**
   * A PROACTIVE turn: the student didn't ask anything, an editor event (a save, a build) did.
   * This is the Proactive Tutor Roadmap's Phase B "structured check-in at natural breakpoints"
   * mechanism, minus the still-unbuilt live-signal instrumentation - a caller (the VS Code
   * extension) decides WHEN to call this (onDidSaveTextDocument, a task success event), this
   * method only decides WHAT to say once called, and it says it grounded in the SAME
   * objective the caller names, never a guess.
   *
   * Requires curriculum (constructor option) - unlike `ask()`, there's no meaningful
   * "opt-out" shape for this method, so it throws rather than silently no-op'ing if
   * TutorSessionOptions.curriculum wasn't supplied, or if objectiveId doesn't exist in it.
   *
   * Deliberately reuses `ask()`'s exact TutorTurnResult shape (including nextSuggestion) so a
   * caller's rendering code doesn't need a second code path for "answer to a question" vs.
   * "unprompted check-in" - both are "the tutor said something grounded", just with a
   * different trigger.
   */
  async checkIn(studentId: string, objectiveId: string, codeContext: string): Promise<TutorTurnResult> {
    if (!this.curriculum) {
      throw new Error("TutorSession.checkIn() requires a curriculum - pass one via TutorSessionOptions.");
    }
    const objective = this.curriculum.get(objectiveId);
    if (!objective) {
      throw new Error(`TutorSession.checkIn(): unknown objectiveId "${objectiveId}".`);
    }

    const answer = this.engine.groundOnKnownChunks(objective.sourceDocIds);
    if (!answer.grounded) {
      return { kind: "refused", reason: answer.refusalReason! };
    }

    const truncatedCode =
      codeContext.length > CHECKIN_CODE_CONTEXT_MAX_CHARS
        ? codeContext.slice(0, CHECKIN_CODE_CONTEXT_MAX_CHARS) + "\n... (truncated)"
        : codeContext;

    const prompt = [
      "You are CaDS Tutor, doing a PROACTIVE check-in. The student did not ask you anything -",
      "you are reviewing their current code in relation to one specific learning objective,",
      "unprompted. Using ONLY the numbered reference excerpts below, give brief, specific",
      "feedback: what's correct so far, what's missing or wrong relative to the objective, or -",
      "if their code already satisfies it - say so plainly and encourage moving on. Do not add",
      "facts that aren't in the excerpts. Cite which excerpt number(s) support your feedback.",
      "",
      `Learning objective: ${objective.statement}`,
      "",
      "Reference excerpts:",
      this.engine.citationContext(answer),
      "",
      "Student's current code:",
      truncatedCode,
    ].join("\n");

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
        objectiveId,
        citedChunkIds: answer.citations.map((c) => c.chunk.id),
        bloomLevel: objective.bloomLevel,
        mode: "checkin",
        hintTier: 0,
      });
    } catch (err) {
      console.warn("TutorSession: failed to record interaction", err);
    }

    const nextSuggestion = this.computeNextSuggestion(studentId);
    return {
      kind: "answer",
      text,
      citations: answer.citations,
      mode: "explain",
      bloomLevel: objective.bloomLevel,
      hintTier: 0,
      nextSuggestion,
    };
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
