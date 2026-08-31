/**
 * A plain, dependency-free BM25 retriever.
 *
 * Why BM25 and not embeddings for v0: it needs no external API, no API
 * key, and no network call to answer a query, which makes the grounding
 * engine's core correctness (does retrieval + the relevance threshold
 * actually work) fully unit-testable without mocking a model. It is also
 * a completely legitimate, well-established choice for retrieval over a
 * controlled documentation corpus, not a placeholder pretending to be a
 * real technique. The Retriever interface (types.ts) is designed so a
 * dense/embedding retriever can be swapped in later - or combined with
 * this one - without changing anything upstream of it.
 */

import type { Chunk, Retriever, RetrievedChunk } from "./types.js";

const K1 = 1.5;
const B = 0.75;

// English stopwords, deliberately included: without this, a query like
// "what is the capital of France" scores nonzero relevance against ANY
// indexed chunk that happens to also contain "is"/"the"/"of" - which on a
// small corpus is nearly every chunk. A grounding engine whose whole job
// is refusing to answer ungrounded questions cannot afford that false
// positive; caught by ground.test.ts's refusal test, not assumed away.
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has",
  "he", "in", "is", "it", "its", "of", "on", "that", "the", "to", "was",
  "were", "will", "with", "what", "which", "who", "whom", "this", "these",
  "those", "or", "but", "if", "then", "so", "do", "does", "did", "can",
  "could", "would", "should",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

interface IndexedDoc {
  chunk: Chunk;
  termFreq: Map<string, number>;
  length: number;
}

export class Bm25Retriever implements Retriever {
  private docs: IndexedDoc[] = [];
  private docFreq: Map<string, number> = new Map();
  private avgDocLength = 0;

  index(chunks: Chunk[]): void {
    this.docs = [];
    this.docFreq = new Map();

    for (const chunk of chunks) {
      const terms = tokenize(chunk.text);
      const termFreq = new Map<string, number>();
      for (const term of terms) {
        termFreq.set(term, (termFreq.get(term) ?? 0) + 1);
      }
      this.docs.push({ chunk, termFreq, length: terms.length });

      for (const term of termFreq.keys()) {
        this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
      }
    }

    const totalLength = this.docs.reduce((sum, d) => sum + d.length, 0);
    this.avgDocLength = this.docs.length > 0 ? totalLength / this.docs.length : 0;
  }

  search(query: string, topK: number): RetrievedChunk[] {
    const queryTerms = tokenize(query);
    const n = this.docs.length;
    if (n === 0 || queryTerms.length === 0) {
      return [];
    }

    const scores: RetrievedChunk[] = this.docs.map((doc) => {
      let score = 0;
      for (const term of queryTerms) {
        const df = this.docFreq.get(term) ?? 0;
        if (df === 0) continue;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        const tf = doc.termFreq.get(term) ?? 0;
        if (tf === 0) continue;
        const denom = tf + K1 * (1 - B + (B * doc.length) / (this.avgDocLength || 1));
        score += idf * ((tf * (K1 + 1)) / denom);
      }
      return { chunk: doc.chunk, score };
    });

    return scores
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}
