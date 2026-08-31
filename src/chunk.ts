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
        id: `${sourceId}-${chunkIndex++}`,
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
