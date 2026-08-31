# CADS-DEMO-tutor-platform

The shared grounding/citation engine behind **CaDS Tutor** — the same tutor persona for both the
STM32 firmware tutor (in [CADS-DEMO-firmware-lab](https://github.com/scimbe/CADS-DEMO-firmware-lab))
and a planned Rust tutor.

## The non-negotiable rule

**No fact about a language or its concepts may come from the LLM itself.** Everything the tutor
teaches must trace back to an indexed reference source with a real URL and license. The model's job
is dialog and explanation — never being the source of truth for what's actually true. See
[`src/ground.ts`](src/ground.ts): `GroundingEngine` never calls an LLM itself; it decides, from
retrieval scores alone, whether a question is answerable from what's indexed, and if not, returns a
fixed refusal rather than a green light to guess.

## How it works

```
reference docs (real, licensed) --chunk--> Chunk[] --index--> Retriever --search--> RetrievedChunk[]
                                                                              |
                                                            score >= threshold?
                                                                    |
                                          yes: GroundedAnswer{grounded:true, citations}
                                          no:  GroundedAnswer{grounded:false, refusalReason}
```

- **`chunk.ts`** — splits markdown along heading boundaries, falling back to sentence- then
  character-level splitting for any single paragraph that's still too long on its own (a real bug
  found by the tests, not a hypothetical — see git history).
- **`bm25.ts`** — a plain, dependency-free BM25 retriever. No embeddings, no API key, no network
  call needed to answer a query. Chosen deliberately for v0: it makes the engine's core correctness
  fully unit-testable without mocking a model, and BM25 over a controlled documentation corpus is a
  legitimate, well-established retrieval technique on its own, not a placeholder. The `Retriever`
  interface is designed so a dense/embedding retriever can be added later — combined with BM25 or
  standalone — without redesigning anything upstream.
- **`ground.ts`** — `GroundingEngine`: ties a `Retriever` to a relevance threshold and produces
  `GroundedAnswer`s, plus `buildGroundedPrompt()`, which formats retrieved chunks (with source,
  license, section) into the *only* material an LLM is allowed to answer from.
- **`session.ts`** — `TutorSession`: orchestrates one real student turn — grounding, then (only if
  grounded) the LLM explanation, then (only if the LLM call succeeded) recording the interaction to
  memory. Each gate is real, not cosmetic: an ungrounded question never reaches the LLM at all, and a
  failed LLM call never gets written to `TutorMemory` as though it were a real exchange. The result is
  a discriminated `TutorTurnResult`:

  ```ts
  type TutorTurnResult =
    | { kind: "refused"; reason: string }
    | { kind: "llm-error"; citations: RetrievedChunk[]; message: string }
    | { kind: "answer"; text: string; citations: RetrievedChunk[]; mode: BloomPromptMode; bloomLevel: BloomLevel };
  ```

  so a caller can `switch` on `kind` and handle "never asked the LLM", "asked and it failed", and "got
  a real answer" as three distinct, type-checked cases instead of inspecting error strings or null
  fields. `llm-error` still carries the citations, so a student sees the reference material even when
  the model itself is down.

  `TutorMemory` (`memory.ts`, wrapping [`CADS-DEMO-student-memory`](https://github.com/scimbe/CADS-DEMO-student-memory))
  exposes both `recordInteraction` and `recallSimilarInteractions`, but `TutorSession` only calls the
  former. That's deliberate, not an oversight: folding prior interactions into the grounded prompt is
  a real design decision — how much history, how stale it's allowed to be, whether conversational
  recall could ever get treated as a fact rather than context — that hasn't been made yet. Wiring it
  in now would have been a guess dressed up as a feature. `recallSimilarInteractions` is implemented
  and available for whichever tutor extension wants it; `session.ts` deliberately doesn't call it
  until that decision is made.

- **`bloom.ts`** — Bloom's-taxonomy-aware, Socratic-mode prompting, shared identically by both the
  Rust and Firmware tracks (one engine, not a per-track reimplementation). `TutorSession.ask()` takes
  an optional `{ bloomLevel, attemptNumber }`: `remember`/`understand` (the default) delegate
  byte-for-byte to `buildGroundedPrompt` — today's unchanged direct-explanation behavior — while
  `apply`/`analyze`/`evaluate`/`create` build a Socratic prompt instead, from the exact same cited
  material (`GroundingEngine#citationContext`, extracted as a pure refactor so both prompt styles are
  provably grounded in identical excerpts). The model is asked to pose ONE guiding question rather
  than answer directly, with a per-level gloss of what that Bloom level actually calls for (e.g.
  `evaluate` → "judge or weigh a trade-off... against an explicit criterion", not just "ask something
  harder"). A caller-supplied `attemptNumber` selects one of three escalation tiers (open question →
  narrower question → a near-direct hint that still stops short of the answer) — deliberately
  caller-driven, not auto-detected from `recallSimilarInteractions`' similarity scores, for the same
  reason the BM25 relevance threshold above needs real per-corpus calibration rather than a
  universal number: guessing an unvalidated "is this a retry" threshold would be exactly the kind of
  guess this project has already been burned by twice. This is the platform's answer to the product
  requirement that the tutor's proactive help work "richtig nach bloomscher Taxonomie" with genuine
  Socratic method, not an LLM system-prompt platitude — see `docs/reference/` in each consuming
  extension for how curriculum steps map to a target Bloom level.

  **A real finding from verifying this against the live LLM, not swept under the rug**: the first
  escalation tier's original wording ("ask exactly ONE open guiding question... do not simply state
  the answer") was not enough — a live call reproducibly padded its one question with a 3-point
  explanatory breakdown that amounted to the direct answer, satisfying the letter of the instruction
  while violating its spirit. Strengthened to an explicit, unambiguous format constraint ("your
  entire response must be that one question and nothing else... a response that explains the concept
  and THEN asks a question has failed this task"), re-verified against the live endpoint (identical,
  correct single-question output across two real calls) — see `tests/bloom.test.ts`'s regression
  guard for the exact wording this depends on.

## A real, honest limitation found while building this

The relevance threshold is an **absolute BM25 score**, and BM25 scores are corpus- and
query-length-dependent — there's no universal "good" number. Concretely: with the default demo
threshold set too low, the question *"how do I write a multithreaded async web server in rust"*
against a corpus that only covers ownership/borrowing/structs came back `grounded: true` — the word
"server" happens to appear in the ownership chapter's restaurant-analogy example, and that alone was
enough to clear a threshold of 1.0. Raising it to 5.0 (calibrated against this specific corpus's real
score distribution — see `src/cli/demo.ts`) fixed it. **This means the threshold needs real
calibration per content pack, not a copy-pasted default**, and is exactly the kind of thing that
needs verification against each pack's actual indexed content before shipping, the same way this
project's own firmware work never trusts an untested assumption.

## Try it yourself

```bash
npm install
npm test                                    # 32 tests, all against real logic/real whisper.cpp, no LLM needed
npm run ingest -- content-packs/rust        # fetches real chapters from github.com/rust-lang/book
npx tsc && node dist/cli/demo.js content-packs/rust "why do I need a reference instead of taking ownership"
```

### Running a real tutor turn (grounding + LLM + memory)

`src/cli/tutor.ts` drives the exact wiring a real tutor extension would use —
`GroundingEngine` + `LlmClient` + `TutorMemory` through `TutorSession` — against a live LLM endpoint,
not a mock:

```bash
npm run tutor -- content-packs/rust student-1 "why do I need a reference instead of taking ownership"
```

This needs a `.env` in the repo root (gitignored — never commit real credentials) with an
OpenAI-chat-compatible endpoint, e.g. a [litellm](https://github.com/BerriAI/litellm) proxy:

```
TUTOR_LLM_BASE_URL=https://your-litellm-proxy.example.com
TUTOR_LLM_API_KEY=your-api-key
TUTOR_LLM_MODEL=your-model-name
```

`LlmClient` (`src/llm.ts`) refuses to construct with a non-`https://` base URL — a plain-http proxy
URL already caused a real, hard-to-diagnose 401 in this project's own firmware-lab tutor (looked like
a bad credential, wasn't one), so that mistake fails loudly here instead of quietly.

### Speech-to-text: the whisper service

`src/stt.ts` wraps [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (`whisper-cli`, real
process, no mocking) for offline speech-to-text — the same integration pattern already proven in
[`CADS-DEMO-deutschlandatlas-callcenter`](https://github.com/scimbe/CADS-DEMO-deutschlandatlas-callcenter)'s
`callcenter_speech/stt.py`, ported to TypeScript rather than reinvented. `src/cli/whisper-service.ts`
puts a small, standalone HTTP service in front of it — kept separate from the main library (like
`student-memory`) because whisper.cpp is a native binary plus a multi-hundred-MB model file, not a
dependency the grounding/dialog code itself should carry.

```bash
npm run setup-whisper          # clones+builds whisper.cpp, downloads a multilingual ggml model
npm run whisper-service        # starts the HTTP service on :8756 (WHISPER_SERVICE_PORT to override)
curl -X POST --data-binary @clip.wav "http://localhost:8756/transcribe?lang=de"   # or lang=en, or omit for auto-detect
```

Real, hardware-verified round trip (not a mock): `say` (macOS's built-in TTS, used only to
generate a test speech clip — this repo doesn't have Piper set up) synthesized "Ask the tutor a
question about ownership and borrowing," POSTed to a running `whisper-service`, and got back
`"Ask the two tour a question about ownership and borrowing."` — a real, honest limitation, not
swept under the rug: whisper.cpp's smallest "base" model, on a synthetic (not natural) voice,
regularly mishears words a human speaker would produce cleanly ("tutor" → "two tour"; separately,
"GPIO" → "gpe open," "firmware" → "film van"). `scripts/setup-whisper-cpp.sh` exists specifically
so this is a one-line escape hatch, not a rebuild: `WHISPER_MODEL_NAME=small` (~488MB) or
`medium` (~1.5GB) for real production accuracy.

## Content packs

| Pack | Sources | Status |
|---|---|---|
| `content-packs/rust/` | The Rust Book (MIT/Apache-2.0), verified before use | 15 sections ingested (270 chunks) — ownership, references/borrowing, slices, structs, enums, match, if-let, vectors, strings, hash maps, panic/Result, generics, traits, lifetimes. A real, coherent core-language course (not the whole book — closures/iterators, smart pointers, concurrency, macros, async, unsafe are not yet covered), calibrated and end-to-end verified against the live LLM endpoint |
| `content-packs/firmware/` | This project's own docs (MIT-licensed, cads-zero itself) | 15 pages ingested (155 chunks) — vscode-setup, build, flash, debug, board-test, first-build/first-gate/lwip-udp-hello tutorials, hal/memory-map/module-layout reference, toolchain/clean-room explanation, SAFETY, HARDWARE. An onboarding-focused set (get a student to a real build/flash/debug loop, then a real network send), calibrated and end-to-end verified — the lwIP tutorial itself was hardware-verified (real UDP packet, real board) before being written here |
| `content-packs/javascript/` | MDN Web Docs JavaScript Guide (CC-BY-SA 2.5, verified live before use) | 7 pages ingested (195 chunks) — introduction, grammar/types, control flow/error handling, loops, functions, objects, arrays. A Lesson-1-equivalent fundamentals set, calibrated and end-to-end verified — real false positives found and fixed at the placeholder threshold (ES6 classes, `==`/`===`, DOM query — none of which this pack actually covers yet) |

**On RM0090 (STM32 reference manual)**: it's copyrighted by STMicroelectronics. Freely downloadable
for reference, but not something to bulk-copy verbatim into a public repo without checking
redistribution rights first — that check hasn't been done. The firmware content pack's v0 sources are
therefore this project's own already-MIT-licensed docs, not the manual itself; specific register
facts should cite the manual by section/URL rather than reproducing its text wholesale, until that's
actually verified.

## Status

This is no longer Phase 0's grounding-only engine. `TutorSession` closes the full loop —
grounding → LLM explanation → memory recording — and that loop has been run end to end for real: a
real question, real BM25 retrieval against ingested Rust Book content, a real HTTP call to a live LLM
endpoint, and a real interaction written to `TutorMemory`, not mocked at any stage. 32 passing tests
(the original grounding suite plus `TutorSession`'s three-case coverage: refused / llm-error /
answer), a working ingestion pipeline against live upstream content, and a verified `tutor` CLI turn.

Still not done: the VS Code extension wiring (CaDS Tutor identity, active observation of what a
student is doing in the editor) lives in `CADS-DEMO-firmware-lab`'s own extension code, not here, and
is in progress there. `recallSimilarInteractions` is implemented but deliberately unused (see
`session.ts` above). See the
[full platform plan](https://claude.ai/code/artifact/67493cd9-2c7e-4922-85e4-256d5a7f7986) for what
comes next and what's still an open decision.

**Known, accepted `npm audit` finding**: 8 high + 1 critical, all transitive through
`student-memory` → `@lancedb/lancedb` → `@xenova/transformers` → `sharp` (libvips CVEs, no upstream
fix available as of this writing). `sharp` is `@xenova/transformers`' image-preprocessing path — this
package only ever embeds *text* (interaction records), never images, so the vulnerable code path is
unreachable from anything this repo actually calls, not a hypothetical "probably fine." Re-check with
`npm audit` next time a dependency bump touches this chain rather than assuming it's still true.

Consumers should pin to a tagged release (starting `v0.2.0`), not track `main` - a git-dependency
install against `main` mid-development was observed by a consumer to pick up two different
`content-packs/rust` `relevanceThreshold` values between two installs a short time apart, a real
reproducibility problem this tag exists to fix.
