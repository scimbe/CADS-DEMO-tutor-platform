import { chunkMarkdown } from "../src/chunk.js";

describe("chunkMarkdown", () => {
  const md = `
# Ownership

Ownership is Rust's most unique feature.

## References and Borrowing

A reference is like a pointer, but it is guaranteed to point to a valid value.

# Structs

Structs let you group related values together.
`;

  it("splits on headings and keeps the heading as the section label", () => {
    const chunks = chunkMarkdown("rust-book", "https://doc.rust-lang.org/book/", md);
    const sections = chunks.map((c) => c.section);
    expect(sections).toContain("Ownership");
    expect(sections).toContain("References and Borrowing");
    expect(sections).toContain("Structs");
  });

  it("builds an anchored URL per section", () => {
    const chunks = chunkMarkdown("rust-book", "https://doc.rust-lang.org/book/", md);
    const refs = chunks.find((c) => c.section === "References and Borrowing");
    expect(refs?.url).toBe("https://doc.rust-lang.org/book/#references-and-borrowing");
  });

  it("splits a section longer than maxChars into multiple chunks", () => {
    const longBody = "This sentence repeats. ".repeat(200);
    const longMd = `# Long section\n\n${longBody}`;
    const chunks = chunkMarkdown("test", "https://example.test/", longMd, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(600); // some slack for paragraph grouping
    }
  });

  it("drops sections with no real content instead of emitting empty chunks", () => {
    const chunks = chunkMarkdown("test", "https://example.test/", "# Empty heading\n\n# Another\n\nReal text here.");
    expect(chunks.every((c) => c.text.trim().length > 0)).toBe(true);
  });

  it("ids never collide across two chapters ingested with the same sourceId - real bug, found 2026-09-02", () => {
    // The exact failure mode that shipped in all three content packs: ingest.ts calls
    // chunkMarkdown once per chapter and concatenates the results. Before this fix, chunkIndex
    // reset to 0 on every call, so chapter 2's first chunk silently reused chapter 1's id.
    const chapter1 = chunkMarkdown("rust-book", "https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html", md);
    const chapter2 = chunkMarkdown("rust-book", "https://doc.rust-lang.org/book/ch10-03-lifetime-syntax.html", md);
    const allIds = [...chapter1, ...chapter2].map((c) => c.id);
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it("the same page chunked twice produces the same ids (deterministic, not random)", () => {
    const a = chunkMarkdown("rust-book", "https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html", md);
    const b = chunkMarkdown("rust-book", "https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html", md);
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
  });
});
