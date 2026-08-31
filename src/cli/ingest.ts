/**
 * Fetches the manifest's chapters from their real, live upstream URLs
 * (not a local fixture), chunks them, and writes an index file the demo
 * script and, later, the actual tutor extension can load without
 * re-fetching every run.
 *
 * Run: npm run ingest -- content-packs/rust
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chunkMarkdown } from "../chunk.js";
import type { Chunk } from "../types.js";

interface Manifest {
  sourceId: string;
  baseRawUrl: string;
  docBaseUrl: string;
  chapters: { file: string; docPath: string }[];
}

async function main() {
  const packDir = process.argv[2];
  if (!packDir) {
    console.error("Usage: ingest <content-pack-dir>");
    process.exit(1);
  }

  const manifestPath = path.join(packDir, "manifest.json");
  const manifest: Manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

  const allChunks: Chunk[] = [];

  for (const chapter of manifest.chapters) {
    const url = manifest.baseRawUrl + chapter.file;
    console.log(`Fetching ${url}`);
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
    }
    const markdown = await res.text();
    const docUrl = manifest.docBaseUrl + chapter.docPath;
    const chunks = chunkMarkdown(manifest.sourceId, docUrl, markdown);
    console.log(`  -> ${chunks.length} chunks`);
    allChunks.push(...chunks);
  }

  const outPath = path.join(packDir, "index.json");
  writeFileSync(outPath, JSON.stringify(allChunks, null, 2));
  console.log(`Wrote ${allChunks.length} total chunks to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
