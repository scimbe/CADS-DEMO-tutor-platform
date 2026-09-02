import type { Chunk, GroundedAnswer, Retriever, RetrievedChunk, Source } from "./types.js";

export interface GroundingEngineOptions {
  /**
   * Minimum BM25 score for a chunk to count as real support for an
   * answer. There is no universally "correct" number for this - it
   * depends on corpus size and query style - so it's a required,
   * explicit option rather than a hidden default a caller has to
   * discover the hard way.
   */
  relevanceThreshold: number;
  topK?: number;
}

/**
 * The thing both content packs (Rust, Firmware) share: given a student's
 * question, decide honestly whether the indexed reference sources
 * actually support an answer, and if so, exactly which chunks back it.
 *
 * This class deliberately does NOT call an LLM. Its output (GroundedAnswer)
 * is what a caller hands to a model as the *only* material it's allowed
 * to answer from - the refusal-when-ungrounded behavior lives here, not
 * in a system prompt the model could ignore.
 */
export class GroundingEngine {
  private sources = new Map<string, Source>();
  private chunksById = new Map<string, Chunk>();

  constructor(
    private readonly retriever: Retriever,
    private readonly options: GroundingEngineOptions
  ) {}

  loadSources(sources: Source[]): void {
    for (const source of sources) {
      this.sources.set(source.id, source);
    }
  }

  indexChunks(chunks: Chunk[]): void {
    for (const chunk of chunks) {
      this.chunksById.set(chunk.id, chunk);
    }
    this.retriever.index(chunks);
  }

  ask(query: string): GroundedAnswer {
    const topK = this.options.topK ?? 5;
    const results = this.retriever.search(query, topK);
    const supported = results.filter((r) => r.score >= this.options.relevanceThreshold);

    if (supported.length === 0) {
      return {
        grounded: false,
        citations: [],
        refusalReason:
          "No indexed reference source covers this closely enough to answer " +
          "responsibly. Rephrase the question, or this may genuinely be " +
          "outside what's been taught so far.",
      };
    }

    return { grounded: true, citations: supported };
  }

  sourceFor(chunk: Chunk): Source | undefined {
    return this.sources.get(chunk.sourceId);
  }

  /**
   * Grounds an answer in a KNOWN set of chunks rather than a BM25 search - for callers that
   * already know exactly which material is relevant (a CurriculumObjective's own
   * `sourceDocIds`, set at authoring time - see curriculum.ts) instead of a student's free-text
   * question. This is what makes a proactive check-in (session.ts's `checkIn`, prompted by
   * code the student wrote, not a question they asked) possible without inventing a fake query
   * string to feed the retriever - retrieval and "which chunks ground this" are two different
   * problems, and an objective already answers the second one directly. Missing ids are
   * silently skipped, not an error: a stale sourceDocId pointing at a chunk that's since been
   * re-ingested with a new id shouldn't crash a check-in, it should just ground on what's still
   * findable - `groundOnKnownChunks([])` or all-missing correctly returns `grounded: false`
   * exactly like an ungrounded `ask()`.
   */
  groundOnKnownChunks(chunkIds: string[]): GroundedAnswer {
    const citations: RetrievedChunk[] = [];
    for (const id of chunkIds) {
      const chunk = this.chunksById.get(id);
      if (chunk) citations.push({ chunk, score: this.options.relevanceThreshold });
    }
    if (citations.length === 0) {
      return {
        grounded: false,
        citations: [],
        refusalReason: "None of this objective's reference chunks are currently indexed - the content pack may be out of sync with the curriculum.",
      };
    }
    return { grounded: true, citations };
  }

  /**
   * Builds the prompt material an LLM is allowed to answer from: the
   * retrieved chunks, each labeled with its source/license/URL, plus an
   * explicit instruction to answer only from what's quoted and to cite
   * which chunk(s) were used. The engine hands the model material and a
   * rule, not a green light to free-associate.
   */
  citationContext(answer: GroundedAnswer): string {
    return answer.citations
      .map((c, i) => {
        const source = this.sourceFor(c.chunk);
        const label = source ? `${source.title} (${source.license})` : c.chunk.sourceId;
        return `[${i + 1}] ${label} — ${c.chunk.section}\n${c.chunk.text}`;
      })
      .join("\n\n");
  }

  buildGroundedPrompt(query: string, answer: GroundedAnswer): string {
    if (!answer.grounded) {
      throw new Error("buildGroundedPrompt called on an ungrounded answer - check answer.grounded first.");
    }

    return [
      "You are CaDS Tutor. Answer the student's question using ONLY the numbered",
      "reference excerpts below. Do not add facts that aren't in them. Cite which",
      "excerpt number(s) you used at the end of your answer.",
      "",
      "Reference excerpts:",
      this.citationContext(answer),
      "",
      `Student's question: ${query}`,
    ].join("\n");
  }
}
