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
});
