import type { BloomPromptMode } from "./bloom.js";
import { buildTutorPrompt } from "./bloom.js";
import type { GroundingEngine } from "./ground.js";
import type { BloomLevel, RetrievedChunk } from "./types.js";

export type TutorTurnResult =
  | { kind: "refused"; reason: string }
  | { kind: "llm-error"; citations: RetrievedChunk[]; message: string }
  | { kind: "answer"; text: string; citations: RetrievedChunk[]; mode: BloomPromptMode; bloomLevel: BloomLevel };

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

/**
 * Orchestrates one student turn across GroundingEngine, an Explainer (the
 * LLM), and an InteractionRecorder (dialog memory) - without letting either
 * of the latter two run on a path where they shouldn't: an ungrounded
 * question never reaches the LLM, and a failed LLM call never gets recorded
 * as a real interaction.
 */
export class TutorSession {
  constructor(
    private readonly engine: GroundingEngine,
    private readonly llm: Explainer,
    private readonly memory: InteractionRecorder
  ) {}

  async ask(studentId: string, query: string, options: AskOptions = {}): Promise<TutorTurnResult> {
    const answer = this.engine.ask(query);
    if (!answer.grounded) {
      return { kind: "refused", reason: answer.refusalReason! };
    }

    const { prompt, mode, bloomLevel } = buildTutorPrompt(this.engine, query, answer, options);

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
      });
    } catch (err) {
      console.warn("TutorSession: failed to record interaction", err);
    }

    return { kind: "answer", text, citations: answer.citations, mode, bloomLevel };
  }
}
