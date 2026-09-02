import { randomUUID } from "node:crypto";
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
 * The trailing line checkIn()'s prompt requires so a real LearningEventStore.record() can
 * happen without guessing. Found live (2026-09-02): mastery estimation and nextSuggestion were
 * already fully built and correctly READING from LearningEventStore, but nothing anywhere ever
 * WROTE to it - ask() and checkIn() only ever called store.query() indirectly (via
 * createIsSatisfied), never store.record(). That's a real, working-as-designed gap for ask()
 * (a Q&A turn has no inherent pass/fail signal - see this file's git history for why that was
 * deliberately left to a future caller), but checkIn() genuinely CAN judge outcome: it's
 * reviewing real code against a real objective, which is exactly what a LearningEvent's
 * outcome field means. Rather than have the LLM's prose feedback silently double as ground
 * truth (fragile, unparseable, and a step toward letting the model originate judgments this
 * platform doesn't structurally trust it to make), the prompt asks for one explicit,
 * machine-parseable line separate from the human-facing feedback - closer to the trust
 * boundary this platform already draws elsewhere (the model explains/judges within a
 * structure code defines, code decides what that structure means).
 */
const CHECKIN_ASSESSMENT_MARKER = "ASSESSMENT:";
type CheckInAssessment = "satisfied" | "partial" | "not_satisfied";

function parseCheckInAssessment(rawText: string): { displayText: string; assessment: CheckInAssessment | null } {
  const lines = rawText.split("\n");
  const lastLine = lines[lines.length - 1]?.trim() ?? "";
  const match = /^ASSESSMENT:\s*(satisfied|partial|not_satisfied)\s*$/i.exec(lastLine);
  if (!match) {
    return { displayText: rawText.trim(), assessment: null };
  }
  return {
    displayText: lines.slice(0, -1).join("\n").trim(),
    assessment: match[1].toLowerCase() as CheckInAssessment,
  };
}

const CHECKIN_ASSESSMENT_TO_OUTCOME: Record<CheckInAssessment, "independent_success" | "partial" | "failure"> = {
  satisfied: "independent_success",
  partial: "partial",
  not_satisfied: "failure",
};

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
  /** One TutorSession instance = one real session, for LearningEvent.sessionId - matches how
   * every real caller (the tutor CLI, the VS Code extension) already constructs a fresh
   * TutorSession per session rather than reusing one across students/sessions. */
  private readonly sessionId = randomUUID();

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
      "",
      "After your feedback, end your response with EXACTLY ONE additional line, on its own,",
      `with no other text on it, in the literal form "${CHECKIN_ASSESSMENT_MARKER} <value>" where`,
      "<value> is one of: satisfied (the code fully demonstrates the objective), partial (real",
      "progress but something's missing or wrong), not_satisfied (doesn't yet demonstrate it).",
      "This line is read by code, not shown to the student - it must be exactly that format.",
    ].join("\n");

    let rawText: string;
    try {
      rawText = await this.llm.complete(prompt);
    } catch (err) {
      return {
        kind: "llm-error",
        citations: answer.citations,
        message: err instanceof Error ? err.message : String(err),
      };
    }

    const { displayText, assessment } = parseCheckInAssessment(rawText);

    try {
      await this.memory.recordInteraction(studentId, displayText, {
        objectiveId,
        citedChunkIds: answer.citations.map((c) => c.chunk.id),
        bloomLevel: objective.bloomLevel,
        mode: "checkin",
        hintTier: 0,
        assessment,
      });
    } catch (err) {
      console.warn("TutorSession: failed to record interaction", err);
    }

    // The one place this class writes to LearningEventStore (see this file's own history: ask()
    // deliberately doesn't, a Q&A turn has no inherent pass/fail signal). Silently skipped, not
    // an error, if the LLM didn't comply with the assessment-line format - recording a guessed
    // outcome would be worse than recording nothing, and a caller can always retry the check-in.
    if (this.learningEvents && this.track && assessment) {
      try {
        this.learningEvents.record({
          entityId: studentId,
          sessionId: this.sessionId,
          track: this.track,
          objectiveId,
          unitId: objective.unitId,
          bloomLevel: objective.bloomLevel,
          exchangeType: null,
          source: "checkin_dialog",
          hintTierReached: 0,
          outcome: CHECKIN_ASSESSMENT_TO_OUTCOME[assessment],
          groundingDocIds: answer.citations.map((c) => c.chunk.id),
        });
      } catch (err) {
        console.warn("TutorSession: failed to record learning event", err);
      }
    } else if (this.learningEvents && this.track && !assessment) {
      console.warn(`TutorSession.checkIn(): LLM response missing a valid "${CHECKIN_ASSESSMENT_MARKER}" line - no learning event recorded.`);
    }

    const nextSuggestion = this.computeNextSuggestion(studentId);
    return {
      kind: "answer",
      text: displayText,
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
