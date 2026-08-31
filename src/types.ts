/**
 * Core types for the CaDS Tutor grounding engine.
 *
 * Non-negotiable design constraint (see the repo README): every fact a
 * tutor states about a language or concept must trace back to a Chunk
 * from a Source with a real license and URL. The engine is built so that
 * "no matching chunk" is a first-class, honest outcome, not something the
 * caller has to remember to check for.
 */

export interface Source {
  /** Stable id, e.g. "rust-book", "cads-zero-docs". */
  id: string;
  /** Human-readable name, e.g. "The Rust Programming Language". */
  title: string;
  /** SPDX-ish license string, e.g. "MIT OR Apache-2.0". */
  license: string;
  /** Canonical URL a citation can link back to. */
  url: string;
}

export interface Chunk {
  id: string;
  sourceId: string;
  /** Where within the source this chunk came from, e.g. a heading path. */
  section: string;
  /** URL to the specific section/anchor, when the source supports it. */
  url: string;
  text: string;
}

export interface RetrievedChunk {
  chunk: Chunk;
  score: number;
}

export interface GroundedAnswer {
  /** True only if at least one chunk cleared the relevance threshold. */
  grounded: boolean;
  /** The chunks the answer is required to cite, empty when not grounded. */
  citations: RetrievedChunk[];
  /**
   * When grounded is false, this is a fixed, honest refusal - never a
   * request to the LLM to "just answer anyway". Callers that want an LLM
   * to phrase a nicer sentence around this must not let it add new facts.
   */
  refusalReason?: string;
}

export interface Retriever {
  index(chunks: Chunk[]): void;
  /** Returns the top candidates, sorted by relevance descending. */
  search(query: string, topK: number): RetrievedChunk[];
}

export type BloomLevel = "remember" | "understand" | "apply" | "analyze" | "evaluate" | "create";

export const BLOOM_LEVELS: readonly BloomLevel[] = ["remember", "understand", "apply", "analyze", "evaluate", "create"];
