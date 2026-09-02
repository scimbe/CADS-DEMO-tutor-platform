import type { Chunk } from "./types.js";

/**
 * Splits markdown text into chunks along heading boundaries, then further
 * splits any section still longer than maxChars into paragraph-grouped
 * pieces. Each chunk keeps the heading path it came from (e.g.
 * "Ownership > References and Borrowing") so a citation can point a
 * student at more than just "somewhere in this book".
 */
export function chunkMarkdown(
  sourceId: string,
  baseUrl: string,
  markdown: string,
  maxChars = 1200
): Chunk[] {
  // Real bug, found live (2026-09-02): chunkIndex used to start at 0 on EVERY call, and
  // ingest.ts calls this function once per chapter, concatenating the results - so chapter 2's
  // chunks silently reused chapter 1's ids ("rust-book-0", "rust-book-1", ...), all the way
  // across every chapter in a pack. All three shipped content packs had this: 270 rust chunks
  // with only 35 unique ids, 155 firmware chunks with 31, 195 javascript chunks with 45 - a
  // majority of every pack's chunks were unreachable by their own id, silently shadowed by a
  // later chapter's chunk claiming the same id. GroundingEngine.ask()'s own citations were
  // accidentally unaffected (they carry the real retrieved Chunk object, never re-looked-up by
  // id) - what actually broke is anything that looks a chunk up BY id, which is exactly what
  // curriculum.json's sourceDocIds (an objective's own grounding material) and
  // groundOnKnownChunks() (session.ts's checkIn()) both do. Fix: derive the id from the page
  // itself (via baseUrl, which is already unique per chapter - see ingest.ts) plus a per-page
  // running index, so two different chapters can never collide no matter how many chunks each
  // produces.
  const pageSlug = baseUrl
    .replace(/^https?:\/\//, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const lines = markdown.split(/\r?\n/);
  const sections: { heading: string; anchor: string; body: string[] }[] = [];
  let current = { heading: "", anchor: "", body: [] as string[] };

  for (const line of lines) {
    const headingMatch = /^(#{1,4})\s+(.*)$/.exec(line);
    if (headingMatch) {
      if (current.body.some((l) => l.trim().length > 0)) {
        sections.push(current);
      }
      const heading = headingMatch[2].trim();
      current = { heading, anchor: slugify(heading), body: [] };
    } else {
      current.body.push(line);
    }
  }
  if (current.body.some((l) => l.trim().length > 0)) {
    sections.push(current);
  }

  const chunks: Chunk[] = [];
  let chunkIndex = 0;

  for (const section of sections) {
    const text = section.body.join("\n").trim();
    if (text.length === 0) continue;

    const pieces = splitLong(text, maxChars);
    for (const piece of pieces) {
      chunks.push({
        id: `${sourceId}-${pageSlug}-${chunkIndex++}`,
        sourceId,
        section: section.heading || "(untitled)",
        url: section.anchor ? `${baseUrl}#${section.anchor}` : baseUrl,
        text: piece,
      });
    }
  }

  return chunks;
}

function splitLong(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const paragraphs = text.split(/\n{2,}/);
  const pieces: string[] = [];
  let buffer = "";

  for (const para of paragraphs) {
    if (buffer.length + para.length + 2 > maxChars && buffer.length > 0) {
      pieces.push(buffer.trim());
      buffer = "";
    }
    if (para.length > maxChars) {
      // A single paragraph longer than the whole limit (no blank-line
      // breaks to split on at all) - the buffer flush above can't help,
      // so fall back to sentence, then hard, splitting within it.
      pieces.push(...splitOversizedParagraph(para, maxChars));
      continue;
    }
    buffer += (buffer ? "\n\n" : "") + para;
  }
  if (buffer.trim().length > 0) pieces.push(buffer.trim());

  return pieces.length > 0 ? pieces : [text.slice(0, maxChars)];
}

function splitOversizedParagraph(para: string, maxChars: number): string[] {
  const sentences = para.split(/(?<=[.!?])\s+/);
  const pieces: string[] = [];
  let buffer = "";

  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      if (buffer.trim().length > 0) pieces.push(buffer.trim());
      buffer = "";
      for (let i = 0; i < sentence.length; i += maxChars) {
        pieces.push(sentence.slice(i, i + maxChars));
      }
      continue;
    }
    if (buffer.length + sentence.length + 1 > maxChars && buffer.length > 0) {
      pieces.push(buffer.trim());
      buffer = "";
    }
    buffer += (buffer ? " " : "") + sentence;
  }
  if (buffer.trim().length > 0) pieces.push(buffer.trim());

  return pieces;
}

function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}
