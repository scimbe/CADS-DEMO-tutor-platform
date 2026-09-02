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
    | { kind: "answer"; text: string; citations: RetrievedChunk[]; mode: BloomPromptMode; bloomLevel: BloomLevel; hintTier: number };
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

- **`learning-event.ts` / `curriculum.ts`** — Phase 1 of the backbone architecture (see the
  [published architecture doc](https://claude.ai/code/artifact/67493cd9-2c7e-4922-85e4-256d5a7f7986)
  for the full merged plan). `LearningEventStore` is the one canonical, append-only event log
  every other backbone table (mastery, XP, badges) will be a derived view over — never
  overwritten, backed by `node:sqlite` (built into Node 22+, zero new dependency, zero new
  hosting coordination) rather than Postgres, on the same "ship something real and fully
  testable now, with a stable-enough interface to swap the backing store later" principle
  `bm25.ts` already documents for retrieval. `CurriculumGraph` is the one authoritative
  prerequisite DAG (an objective with no `sourceDocIds` throws — a goal must trace to real
  reference material, never be invented, the same non-negotiable rule this whole platform
  already enforces for facts) and exposes `computeFrontier()`, the mechanical "what should this
  student attempt next" query a future check-in dialog (Phase 4) will hand to the LLM as its
  only candidate set to phrase, never to choose from freely.

  `bloom.ts#buildTutorPrompt()` and `TutorSession.ask()` both now return `hintTier` (0 for
  explain mode, 1-3 for the Socratic escalation tier actually shown) — this is what a caller
  records into a `learning_event` once the turn's real outcome is known. `TutorSession` itself
  deliberately does NOT auto-write learning events: a single turn can't know whether the
  student ultimately succeeded independently or needed the answer spelled out next turn, so
  guessing an outcome here would be exactly the kind of invented signal this project doesn't
  ship. See `tests/learning-event.test.ts`/`tests/curriculum.test.ts` for real, disk-persisted
  SQLite round-trips, not mocks.

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
npm test                                    # 45 tests, all against real logic/real whisper.cpp/real SQLite, no LLM needed
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

## Curriculum objectives (adaptive sequencing)

Grounding answers "what is true"; the curriculum graph answers "what's next". Every chapter in
every content pack is now a real `CurriculumObjective` (see `curriculum.ts`) — 37 total (15
firmware, 15 rust, 7 javascript) — each with a real prerequisite chain (hand-authored per track:
Rust follows the Book's own chapter order, firmware puts SAFETY before flash/debug and groups
reference material after the build step that makes it legible, JavaScript follows the MDN Guide's
own sequence) and `sourceDocIds` pointing at the exact chunks that ground it — an objective with no
source material is a construction-time error, not a runtime surprise (`CurriculumGraph`'s
constructor throws).

`content-packs/curriculum.json` is generated, not hand-typed: `scripts/gen-curriculum.py` reads each
pack's `manifest.json` (chapter list) and `index.json` (indexed chunks), matches chunks to chapters
by URL, and merges that with a hand-authored table of `(bloomLevel, statement, prerequisites)` per
chapter. Re-run it after a content pack's `manifest.json` changes. `loadCurriculumObjectives()`
loads the result into one `CurriculumGraph` spanning all tracks at once (objective ids are
track-namespaced, so this is safe — see the function's own doc comment for why one graph is correct
here, not three).

`CurriculumGraph.computeFrontier(track, isSatisfied)` is the actual "what's next" query — it returns
every objective in a track whose prerequisites are all satisfied and which isn't itself satisfied
yet. `isSatisfied` is no longer injected as a stub — `mastery.ts`'s `createIsSatisfied(store, entityId)`
backs it with a real, deterministic estimate over `LearningEventStore`: a recency-weighted,
hint-tier-discounted average of each event's evidence score (an unaided `independent_success`
counts fully; a hint-tier-3 `assisted_success` counts for roughly a fifth as much — a tier-3 answer
is much weaker evidence of real understanding than an unaided one). No LLM in the loop anywhere in
this calculation — the classifier stays a pure function over logged outcomes, per the Proactive
Tutor Roadmap's own trust-boundary rule. `src/cli/frontier.ts` (`npm run frontier <track>
<studentId>`) exercises the whole chain for real: real curriculum graph, real event store, real
mastery estimate, real `computeFrontier` call — not just isolated unit tests of each piece.
Verified live: a fresh student starts at the true root objective; after recording one real
`independent_success` event, the frontier genuinely advances to the next legal objective. Real,
load-bearing test coverage: 13 new tests for `mastery.ts` (including the exact case that caught a
wrong assumption in the first draft — a single isolated event's estimate doesn't decay toward 0 in
a vacuum, since this is a normalized weighted average, not a raw decaying score) plus the existing
10 for `curriculum.ts`, 4 of which run against the real generated dataset.

`TutorSession` now closes the loop the roadmap called "leads instead of waits": pass a
`CurriculumGraph` + `LearningEventStore` + `track` to its constructor (all optional — omit any one
and `nextSuggestion` is simply always `null`, so every existing caller keeps working unchanged) and
every successful answer turn comes back with `nextSuggestion` — the single next-legal objective for
that student, chosen by code via `computeFrontier`, never by the LLM. A caller phrases it however
it wants (or not at all); `TutorSession`'s job stops at the selection, which is the actual
trust-boundary-sensitive part. Live-verified against the real LLM endpoint and the real rust
content pack: a fresh student's first turn suggests the true root objective; after a second real
turn with one recorded `independent_success` in between, the suggestion correctly advances to the
next legal objective. 5 new tests, including one confirming the suggestion never appears on a
`refused` or `llm-error` turn (only a real completed answer produces one) and one confirming it's
scoped per-student. 78 tests total.

Still open from the roadmap's Phase A: the self-explanation gate (mechanism #2 — a correct answer
at apply-or-above shouldn't itself count as mastery until a near-transfer follow-up also passes)
needs a real "submit work, get judged" interaction shape that doesn't exist yet in this API
(`TutorSession.ask()` today is "student asks, tutor answers/guides," not "student submits, tutor
grades") — deliberately not forced into the current shape without that design thought, rather than
shipping a mismatched abstraction. The Frontier Map (visible DAG in the webview) and
misconception-tagged remediation are still unbuilt.

## Proactive check-ins (Phase B, minus live editor signals)

Everything above is still request-response: the student has to ask something before the tutor
says anything. `TutorSession.checkIn(studentId, objectiveId, codeContext)` is the first piece of
Phase B — "notice what the student is doing before they ask" — built directly from live operator
feedback ("wenn ich im Quellcode was mache, bekomme ich kein Feedback"). A caller (the VS Code
extension, on a file save or a build event — that instrumentation is still the extension's own
work, not built here) hands it the objective the student is currently working toward and their
current code; `checkIn` grounds the feedback in exactly that objective's own `sourceDocIds` via
`GroundingEngine.groundOnKnownChunks()` — no BM25 search of the code (code doesn't share prose
vocabulary with reference material, and the objective already answers "what's relevant" more
precisely than a search would) — and returns the same `TutorTurnResult` shape `ask()` does,
`nextSuggestion` included, so a caller's rendering code doesn't need a second path for "answered a
question" versus "unprompted check-in."

Finding and fixing this exposed a real, serious, pre-existing bug (see the chunk-id-collision fix
commit) — `checkIn` is the first thing in this codebase that looks a chunk up strictly by id
instead of trusting whatever a BM25 search or `sourceDocIds` array already resolved, and that's
exactly what turned a silent, years-old-shaped bug into a same-day fix. Live-verified against the
real LLM endpoint with deliberately-wrong code (using a `String` after it was moved): the feedback
correctly identified the compile error, correctly explained why, and cited only genuinely
on-topic ownership excerpts. 5 new tests plus 4 for the new `groundOnKnownChunks()` primitive.

## Status

This is no longer Phase 0's grounding-only engine. `TutorSession` closes the full loop —
grounding → LLM explanation → memory recording — and that loop has been run end to end for real: a
real question, real BM25 retrieval against ingested Rust Book content, a real HTTP call to a live LLM
endpoint, and a real interaction written to `TutorMemory`, not mocked at any stage. 78 passing tests
(the original grounding suite, `TutorSession`'s coverage including the turn-end suggestion,
`LearningEventStore`, `CurriculumGraph` including the real generated multi-track objective set, and
`mastery.ts`'s real `isSatisfied` implementation), a working ingestion pipeline against live
upstream content, a verified `tutor` CLI turn (now including a live-verified proactive suggestion),
and a verified `frontier` CLI turn (curriculum graph + event store + mastery estimate, end to end,
live).

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
