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

// Question words and filler for matching a question against section headings. Wider than
// STOPWORDS and bilingual: the tutors are used in German over English reference text, so "Was ist
// Ownership?" must reduce to the same topic as "What is ownership?". Track names are here because
// every chunk of a pack is about them; they say nothing about the topic.
const TOPIC_STOPWORDS = new Set([
  ...STOPWORDS,
  ..."how why when where my me you your explain use using work works best rust javascript js".split(" "),
  ..."der die das den dem des ein eine einen einem einer ist sind wie warum wann wo wer ich du man kann können mir mich und oder im am auf aus bei mit nach von zu zum zur für nicht es sich wird werden funktioniert erkläre erklär bedeutet heißt heisst macht".split(" "),
]);

function topicTerms(text: string): Set<string> {
  const terms = text
    .toLowerCase()
    .replace(/[^a-z0-9_äöüß]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !TOPIC_STOPWORDS.has(t))
    .map((t) => t.replace(/ies$/, "y").replace(/s$/, ""));
  return new Set(terms);
}

interface IndexedDoc {
  chunk: Chunk;
  termFreq: Map<string, number>;
  length: number;
  sectionTerms: Set<string>;
  textTerms: Set<string>;
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
      this.docs.push({
        chunk,
        termFreq,
        length: terms.length,
        sectionTerms: topicTerms(chunk.section ?? ""),
        textTerms: topicTerms(chunk.text),
      });

      for (const term of termFreq.keys()) {
        this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
      }
    }

    const totalLength = this.docs.reduce((sum, d) => sum + d.length, 0);
    this.avgDocLength = this.docs.length > 0 ? totalLength / this.docs.length : 0;
  }

  /**
   * Chunks that are ABOUT the question: every topic term occurs in the chunk and at least one in
   * its section heading. BM25 sums over query terms, so a short, direct question ("What is
   * ownership?" scores 3.6) cannot reach a threshold calibrated on long ones, and scores no higher
   * than an off-topic one ("What is the capital of France?" scores 4.5). Requiring all terms is
   * what keeps the off-topic ones out: France, carbonara, or closures in a pack without that
   * chapter never match a heading.
   */
  searchTopic(query: string, topK: number): RetrievedChunk[] {
    const terms = [...topicTerms(query)];
    if (terms.length === 0) {
      return [];
    }
    const bm25 = new Map(this.search(query, this.docs.length).map((r) => [r.chunk.id, r.score]));
    return this.docs
      .filter((d) => terms.every((t) => d.textTerms.has(t) || d.sectionTerms.has(t)) && terms.some((t) => d.sectionTerms.has(t)))
      .map((d) => ({ chunk: d.chunk, score: bm25.get(d.chunk.id) ?? 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
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
