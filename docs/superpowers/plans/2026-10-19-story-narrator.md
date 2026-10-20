# Story Narrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a separate Cutline Story Narrator tab that turns the creator's unchanged script and authorized background MP4 into a private, captioned vertical video using real local Piper, Whisper and FFmpeg.

**Architecture:** Introduce story-specific contracts, persistence, asynchronous jobs and routes inside the existing Express/React application. Reuse media validation, FFmpeg concurrency, caption styling and atomic JSON writes, adding backward-compatible cancellation to shared subprocess/queue helpers. Story duration follows narration and never passes through clipping-duration validation.

**Tech Stack:** React, strict TypeScript/NodeNext, Node.js, Express, Multer, Zod, FFmpeg/ffprobe, existing openai-whisper, Python 3.11, piper-tts==1.8.0, node:test/tsx and Playwright.

**Spec:** [2026-10-19-story-narrator-design.md](../specs/2026-10-19-story-narrator-design.md), approved by the user; baseline spec commit `dc8c621`.

## Global Constraints

- Preserve all existing navigation destinations, recording projects, clipping duration settings, retention editing, Twitch/YouTube integrations and rights review.
- The supplied script is the authoritative text. Do not summarize, rewrite, translate, add commentary or introduce claims.
- Stories can be shorter than 30 seconds or longer than a minute. Do not apply the clipper's minimum duration, maximum highlight count, highlight analysis or narrative-selection validators to story jobs.
- Use the project's local Python environment and the maintained `piper-tts==1.8.0` package. Default voice is `en_US-lessac-medium`.
- Speaking speed ranges from 0.75x to 1.5x, default 1x. Use 150 words/minute divided by the selected speed for the estimate.
- Initial script limits are 1–30,000 characters and at most 128 KiB UTF-8. Music's cap is 100 MiB; footage uses existing `MAX_UPLOAD_GB`.
- Admit at most 20 active/queued story attempts, with one story attempt running at a time. Voice previews have one active slot and at most two queued requests.
- Expire voice previews after 15 minutes and clean orphaned uploads older than one hour. Periodic maintenance timers must not keep tests or shutdown alive.
- Output 1080x1920, square pixels, 30 FPS, yuv420p, H.264/AAC with fast-start metadata. Finish video within 100 ms of measured narration duration.
- Auto slows short footage only between 1x and 0.75x; otherwise loop with a 250 ms dissolve, reduced for very short sources. Do not hide a hard-cut fallback.
- Use direct executables or Python `-m` invocation with `shell:false` and hidden Windows windows. Wait for subprocess termination before cleanup.
- Keep outputs local/private; require footage/music permission and music provenance. No voice cloning, public hosting or publishing endpoints.
- Prefix shell commands with `rtk`. Keep secrets, models, uploads and generated artifacts out of Git. Preserve strict checking, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- Existing duration-policy changes are uncommitted. Preserve them. Use the worktree skill at execution time to select safe isolation. Inspect staged diffs before any task checkpoint; never commit the earlier edits accidentally. If selective staging cannot distinguish earlier edits, leave those files uncommitted and report that fact.
- This plan is not authorization to install dependencies or write product code before plan approval. During execution, perform authorized reversible work autonomously and use tool escalation only when the environment requires it.

## Review Focus

1. Repeated words and numeric/contraction equivalents must preserve every original script token without assigning fabricated individual word timings; pin in Task 5.
2. Narration ending within the final loop dissolve must retain its final audible marker and caption, including fractional-frame durations; pin in Task 6.
3. A cancelled waiter or cancellation racing final promotion must not launch a late process or erase the previous successful draft; pin in Tasks 2 and 7.
4. Disconnects midway through multipart music upload and Windows file locks must not leave active writers or escape cleanup ownership; pin in Tasks 3 and 8.
5. An unavailable Piper installation must leave recording workflows usable, and a stale voice preview must not play after a voice/speed change; pin in Tasks 1, 8 and 9.

## File and dependency map

| Files | Responsibility |
| --- | --- |
| `src/shared/story.ts` | Strict story settings/public contracts, statuses, script statistics and typed errors. |
| `src/server/story/config.ts`, `voices.ts` | Story configuration, operator-controlled voice registry and engine readiness; no eager failure of ordinary app startup. |
| `src/server/process.ts`, `media.ts`, `models.ts` | Backward-compatible abortable execution, queue waits and Whisper calls. |
| `src/server/story/store.ts`, `paths.ts` | Story records, attempt directories, atomic writes, safe artifact resolution and cleanup. |
| `src/server/story/chunks.ts`, `piper.ts`, `audio.ts` | Exact script spans, real synthesis, PCM normalization/concatenation and measured offsets. |
| `src/server/story/alignment.ts`, `captions.ts` | Script-to-Whisper mapping and existing ASS/SRT reuse on an identity timeline. |
| `src/server/story/background.ts`, `render.ts` | Duration fitting, seamless repeat units, audio ducking and verified output encoding. |
| `src/server/story/pipeline.ts`, `jobs.ts`, `previews.ts` | Cancellable processing stages, admission, durable attempts and expiring voice previews. |
| `src/server/story/uploads.ts`, `routes.ts`; `src/server/app.ts`, `index.ts` | Validated multipart intake, private HTTP routes and lifecycle integration. |
| `src/client/StoryNarrator.tsx`, `story-api.ts`, `story.css` | Story form, uploads, polling, controls, cancellation and media playback. |
| `src/client/CaptionSettings.tsx`, `RetentionEditor.tsx`, `App.tsx` | Shared caption controls and minimal navigation integration. |
| `tests/story-*.test.ts`, `tests/process.test.ts`, `tests/fixtures/story/` | Unit, API, cancellation and real-media regressions. |
| `assets/story-samples/`, `scripts/smoke-story.ts`, `scripts/check-story-ui.ts` | Original sample stories, live engine validation and browser acceptance. |
| `.env.example`, `README.md`, `package.json`, `docs/story-narrator-validation.md` | Reproducible setup, commands and measured validation report. |

Dependencies: Task 1 supplies contracts; Task 2 cancellation; Task 3 persistence. Tasks 4–6 build the media pipeline in order. Task 7 assembles jobs, Task 8 exposes routes, Task 9 integrates UI, and Task 10 verifies the complete feature. Do not split this feature into separate disconnected apps or services.

### Task 1: Story settings, statistics and readiness configuration

**Files:** Create `src/shared/story.ts`, `src/server/story/config.ts`, `src/server/story/voices.ts`, `tests/story-settings.test.ts`, `tests/story-voices.test.ts`. Update `.env.example` with the approved configuration variables, without credentials.

**Interfaces:**
- Produce `storySettingsSchema`, `StorySettings = z.infer<typeof storySettingsSchema>`, `StoryStatus`, `StoryError`, `PublicVoice`, `StoryProgress`, `StoryJob`, `StorySummary` and `VoicePreview`.
- Settings fields are exactly `{ script, voiceId, speed, subtitles, layout, cropX, fitMode, backgroundMuted, backgroundGainDb, musicGainDb, rights }`; `fitMode` is `'auto' | 'loop' | 'slow-loop'`; subtitles reuse `captionStyleSchema`; rights contain `footagePermission` and optional music `{ permission, license: 'owned' | 'licensed', provenance }`.
- Public job shape: `{ id, createdAt, updatedAt, settings, backgroundName, musicName?, attemptId, status, progress, actualDuration?, warnings, error: StoryError | null, successfulAttemptId?, previewUrl?, downloadUrl?, captionsUrl? }`. Do not expose internal paths. Progress shape: `{ stage, percent, completed, total }`.
- Produce `storyStats(script: string, speed: number): { words: number; characters: number; estimatedSeconds: number }`, `loadVoiceCatalog(directory: string): Promise<VoiceDefinition[]>`, `getStoryReadiness(): Promise<StoryReadiness>` and `StoryRequestError(code: string, message: string, status: number)`.
- `VoiceDefinition` extends `PublicVoice` with internal `modelPath`/`configPath`; `PublicVoice` is `{ id, label, language, licenseUrl, installed }`; readiness is `{ piper, whisper, ffmpeg, ffprobe, defaultVoiceId, voices: PublicVoice[] }`.

- [ ] Write failing tests: whitespace-only/NUL input fails; a 30,001-character script fails at the default cap; unauthorized footage fails; speed 0.75 and 1.5 pass and 0.74 fails; gains -45/0 pass and NaN fails; `storyStats('One two three.', 1)` returns 3 words and 1.2 seconds; a short script is valid independently of clipping minimums. Validate UTF-8 bytes and Unicode input without dropping characters.

```ts
assert.deepEqual(storyStats('One two three.', 1), { words: 3, characters: 14, estimatedSeconds: 1.2 });
assert.equal(storySettingsSchema.safeParse({ ...validSettings, script: 'x'.repeat(30_001) }).success, false);
```

- [ ] Run `rtk proxy npx tsx --test tests/story-settings.test.ts tests/story-voices.test.ts`; confirm missing/new behavior fails before implementation.
- [ ] Implement the contracts and strict settings validation. Use Unicode word segmentation and the same character-count rule in UI/backend. Resolve `PIPER_PYTHON` to the platform's project `.venv` executable by default; read other defaults/bounds from the spec. Load `voices.json` only under the configured voice directory; registry entries use relative model/config filenames, a permission declaration and a primary license/model-card URL. Reject traversal/symlink escapes and invalid model JSON. Readiness reports missing setup instead of throwing during unrelated application startup.
- [ ] Add/verify readiness tests: arbitrary browser voice paths/URLs are never accepted; absent Piper returns `piper:false` and an empty/unavailable catalog; existing clip settings remain usable. Include a two-entry registry fixture to exercise voice selection without requiring two production downloads.
- [ ] Run the task tests and `rtk proxy npm run typecheck`; checkpoint only story-owned changes.

### Task 2: Abortable subprocesses and queue waits

**Files:** Modify `src/server/process.ts`, `src/server/media.ts`, `src/server/models.ts`; create `tests/process.test.ts`, `tests/fixtures/story/process-child.cjs`.

**Interfaces:**
- Extend `ProcessOptions` with `signal?: AbortSignal`; preserve `runProcess(executable: string, args: string[], options?: ProcessOptions): Promise<string>`.
- Extend `Semaphore.run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T>` and `ffmpeg(args: string[], onLine?: (line: string) => void, signal?: AbortSignal): Promise<string>`.
- Extend `transcribeChunk(wav: string, outputDir: string, options?: { signal?: AbortSignal; initialPrompt?: string; language?: string }): Promise<Segment[]>`; all old two-argument calls retain their behavior.

- [ ] Write failing tests using a real Node child fixture that signals startup/closure and writes a marker file: abort before spawn creates no marker; abort after startup rejects only after closure; timeout also waits for closure; a cancelled semaphore waiter never calls its operation; remaining waiters retain FIFO/concurrency guarantees. Pin abort racing a successful child exit and absence of duplicate settlement.

```ts
await assert.rejects(cancelledWaiter, { name: 'AbortError' });
assert.equal(cancelledOperationCalls, 0);
assert.equal(childHasClosedWhenPromiseSettles, true);
```

- [ ] Run `rtk proxy npx tsx --test tests/process.test.ts`; verify failure is caused by absent cancellation behavior.
- [ ] Implement abort listeners and termination with one settlement path. Handle abort between the pre-spawn check and listener registration. Remove queued abort listeners and timers. On Windows, use a recorded PID-specific process-tree termination only when needed; never kill unrelated processes. Keep shell execution disabled/windows hidden. Propagate signals through FFmpeg and Whisper; append Whisper's initial prompt/language safely as argument-array values, without logging script text.
- [ ] Run `rtk proxy npx tsx --test tests/process.test.ts tests/jobs.test.ts tests/whisper.test.ts tests/models.test.ts`; verify old invocation, PATH handling, error and timeout tests remain valid.
- [ ] Checkpoint only the new cancellation changes; preserve existing duration-policy hunks in modified files.

### Task 3: Story persistence and safe artifact ownership

**Files:** Create `src/server/story/store.ts`, `src/server/story/paths.ts`, `tests/story-store.test.ts`.

**Interfaces:**
- Produce server-only `StoryRecord` containing the public job fields plus retained asset descriptors, private successful artifact filenames and attempt metadata. An asset descriptor is `{ filename, originalName, hash, duration, hasAudio, width?, height? }`.
- Produce `StoryStore(root: string)` with `init(): Promise<void>`, `save(record: StoryRecord): Promise<void>`, `get(id: string): StoryRecord`, `list(): StoryRecord[]`, `createAttempt(record: StoryRecord): Promise<string>`, `promote(record: StoryRecord, artifacts: StoryArtifacts): Promise<void>`, and `cleanupAttempt(id: string, attemptId: string): Promise<void>`.
- `StoryArtifacts` is `{ attemptId, narrationDuration, videoDuration, videoFile, manifestFile, captionsFile? }`. Fixed files resolve beneath `root/story-videos/<id>/runs/<attemptId>/`; `resolveStoryArtifact(root, jobId, attemptId, filename): Promise<string>` validates UUIDs, filename allowlist and real-path containment.

- [ ] Write failing tests: two saves serialize correctly; invalid IDs/paths and symlink/junction escapes fail; interruption becomes a retryable error on reload; failed/cancelled new attempts preserve `successfulAttemptId`; partial files are never previewable; cleanup cannot delete retained inputs or prior successful artifacts.

```ts
await store.cleanupAttempt(jobId, failedAttemptId);
assert.equal(store.get(jobId).successfulAttemptId, previousSuccessfulAttemptId);
assert.equal(await stat(previousVideo).then(s => s.isFile()), true);
```

- [ ] Run `rtk proxy npx tsx --test tests/story-store.test.ts` and observe the missing persistence/ownership behavior.
- [ ] Implement under `DATA_DIR/story-videos`, reusing `writeJson`/`readJson` atomic writes without inserting story records into the recording `JobStore`. Keep promotion serialized with cancellation decisions. Create per-attempt work/final directories with generated names. Startup clears owned interrupted work after recording interruption metadata; persist bounded cleanup warnings if Windows locks prevent deletion and retry on the next startup.
- [ ] Exercise a real locked-file cleanup failure where supported, plus an injected filesystem failure for deterministic CI coverage. Ensure an active writer is never mistaken for an orphan.
- [ ] Run task tests and typecheck; checkpoint story-store files.

### Task 4: Exact script chunks and real Piper narration

**Files:** Create `src/server/story/chunks.ts`, `src/server/story/piper.ts`, `src/server/story/audio.ts`, `tests/story-chunks.test.ts`, `tests/story-piper.test.ts`; update `README.md` with local TTS setup.

**Interfaces:**
- Consume `StorySettings`, `VoiceDefinition`, cancellation helpers and `StoryProgress`.
- Produce `StoryChunk = { index, text, startOffset, endOffset, paragraphEnd }` and `splitStory(script: string, maxCharacters: number): StoryChunk[]`.
- Produce `PiperSynthesizer.synthesize(input: { textFile: string; wavFile: string; voice: VoiceDefinition; speed: number }, signal: AbortSignal): Promise<void>`.
- Produce `NarrationChunk = StoryChunk & { wavFile: string; duration: number; offset: number }`, `NarrationResult = { wavFile: string; duration: number; chunks: NarrationChunk[] }` and `synthesizeNarration(settings: StorySettings, voice: VoiceDefinition, workDir: string, signal: AbortSignal, onProgress: (completed: number, total: number) => Promise<void>): Promise<NarrationResult>`.
- Produce `probeAudio(file: string, signal?: AbortSignal): Promise<{ duration: number; sampleRate: number; channels: number }>`.

- [ ] Write failing chunk tests for paragraph boundaries, sentences over 800 characters, repeated words, Unicode punctuation and an unbroken token exceeding the hard chunk bound. Assert original source spans reconstruct the original script without omitted/duplicated tokens; reject unsupported overlong tokens explicitly rather than truncate. `splitStory('One.\n\nTwo.', 800)` must retain both sentences and paragraph identity.
- [ ] Write failing Piper adapter tests with a child-process fixture, not a fake implementation of the adapter: assert input comes from UTF-8 files; speed 1.5 yields `length_scale` near 2/3; unavailable/empty/corrupt/nonzero-exit output fails; abort stops synthesis before the next chunk; shell-like story text remains inert text.

```ts
assert.deepEqual(splitStory('One.\n\nTwo.', 800).map(c => c.text), ['One.', 'Two.']);
assert.ok(Math.abs(narration.chunks[1]!.offset - firstNormalizedWavDuration) < 0.001);
await assert.rejects(synthesizingEmptyOutput, /empty|audio|duration/i);
```

- [ ] Run `rtk proxy npx tsx --test tests/story-chunks.test.ts tests/story-piper.test.ts`; verify new behavior fails.
- [ ] Implement splitting with source spans, then Python `-m piper` using the explicit registry model/config paths, file input/output and the inverse-speed flag. Use 120 ms sentence silence and a 280 ms paragraph boundary pause, documenting these values; avoid adding both boundary pauses to the same gap. Normalize outputs to mono 48 kHz PCM, concatenate only generated filenames, probe every final chunk/combined output, and compute offsets from actual normalized durations. Never crossfade speech or add filler.
- [ ] Document exact setup commands: `rtk proxy .venv\Scripts\python.exe -m pip install piper-tts==1.8.0`, followed by `rtk proxy .venv\Scripts\python.exe -m piper.download_voices en_US-lessac-medium --data-dir data/piper-voices`. Supply the `voices.json` example, required `.onnx`/`.onnx.json` filenames, model-card/runtime-license links and a file-input WAV check. During execution install/download only with the required sandbox escalation; run `pip check` and preserve existing Whisper usability.
- [ ] Run tests/typecheck and a real short WAV synthesis after setup. Record actual duration; distinguish automated fixtures from live Piper evidence. Checkpoint this task's files.

### Task 5: Script-verified Whisper alignment and captions

**Files:** Create `src/server/story/alignment.ts`, `src/server/story/captions.ts`, `tests/story-alignment.test.ts`, `tests/story-captions.test.ts`.

**Interfaces:**
- Consume `NarrationResult`, `StorySettings`, existing `Segment`/`Word`, abortable `transcribeChunk`, `createAss` and `createRetentionSrt`.
- Produce `alignScript(script: string, recognized: Word[], duration: number): { segments: Segment[]; coverage: number; warnings: string[] }` and `alignNarration(narration: NarrationResult, settings: StorySettings, workDir: string, signal: AbortSignal, onProgress: (completed: number, total: number) => Promise<void>): Promise<{ segments: Segment[]; coverage: number; warnings: string[] }>`.
- Produce `writeStoryCaptions(segments: Segment[], duration: number, style: CaptionStyle, directory: string): Promise<{ assFile: string; srtFile: string }>`; it creates an identity timeline, never retention `buildEdl`.

- [ ] Write failing tests: all original words remain ordered; hallucinated recognition insertions do not become captions; a missing script word triggers `CAPTION_ALIGNMENT_REVIEW_REQUIRED`; invalid/reversed/out-of-bounds timestamps fail; two chunks use measured offsets, including their real pauses. Repeated-word fixture `Go, go now.` must map to two distinct supplied `go` spans.
- [ ] Pin supported equivalents as literal fixtures: `42` versus `forty two`, `don't` versus `do not`, case/punctuation, and original Unicode spelling. When multiple original tokens map to one recognized span, display a composite caption span and highlight it together; do not invent sub-word timing or duplicate overlapping word spans.

```ts
assert.equal(alignScript('Go, go now.', recognizedGoGoNow, 2).coverage, 1);
assert.throws(() => alignScript('Go, go now.', recognizedGoNow, 2), error => error instanceof StoryRequestError && error.code === 'CAPTION_ALIGNMENT_REVIEW_REQUIRED');
```

- [ ] Run `rtk proxy npx tsx --test tests/story-alignment.test.ts tests/story-captions.test.ts`; confirm failures precede implementation.
- [ ] Implement monotonic dynamic-programming matching of normalized tokens, with bounded phrase equivalences and explicit English number/contraction normalization. Recognized insertions may be excluded, but every original script token must have supported timing exactly once; unknown substitutions/deletions remain errors. Keep original text/punctuation in resulting segments. Retry a failed chunk once with exact-script initial prompt; never recover by evenly spacing unmatched words. Skip Whisper entirely when captions are disabled.
- [ ] Reuse caption styling/escaping and readable grouping on the identity timeline. Tests must verify no script words disappear in ASS/SRT, disabled highlighting uses source timing, and a 5-second story produces captions without hitting the clipper minimum.
- [ ] Run task tests plus `rtk proxy npx tsx --test tests/retention.test.ts tests/subtitles.test.ts`; checkpoint alignment/caption files.

### Task 6: Natural-duration backgrounds, ducking and MP4 rendering

**Files:** Create `src/server/story/background.ts`, `src/server/story/render.ts`, `tests/story-background.test.ts`, `tests/story-render.test.ts`.

**Interfaces:**
- Produce `BackgroundFit = { mode: 'trim' | 'slow' | 'loop'; playbackRate: number; dissolveSeconds: number }` and `planBackground(backgroundDuration: number, narrationDuration: number, fitMode: StorySettings['fitMode']): BackgroundFit`.
- Produce `prepareStoryBackground(input: { video: string; music?: string; duration: number; settings: StorySettings; workDir: string }, signal: AbortSignal): Promise<{ videoFile: string; bedFile?: string }>`.
- Produce `renderStory(input: { background: { videoFile: string; bedFile?: string }; narrationFile: string; narrationDuration: number; assFile?: string; outputDirectory: string; settings: StorySettings }, signal: AbortSignal, onEncodedTime: (seconds: number) => Promise<void>): Promise<{ videoFile: string; videoDuration: number }>`.

- [ ] Write failing fit tests: footage 12s/narration 5s trims; footage 9s/narration 12s Auto uses 0.75x; footage 5s/narration 30s loops; fractional narration and sources shorter than the normal dissolve do not generate negative spans. Explicit Slow then loop uses 0.75x before repetition where needed.
- [ ] Write real FFmpeg tests with owned generated media: 3–5s narration is accepted; narration longer than background preserves its final audible marker and last subtitle; visual/audio seam times do not introduce a frame or audio discontinuity; final streams are 1080x1920 H.264/AAC, start near zero and end within 0.1s of narration. Test silent footage, music, mute and ducked original audio.

```ts
assert.equal(planBackground(9, 12, 'auto').playbackRate, 0.75);
assert.equal(planBackground(5, 30, 'auto').mode, 'loop');
assert.ok(Math.abs(rendered.videoDuration - measuredNarrationDuration) <= 0.1);
```

- [ ] Run `rtk proxy npx tsx --test tests/story-background.test.ts tests/story-render.test.ts`; observe failures before implementation.
- [ ] Implement trim/slow modes and a bounded seamless repeat unit. For loop unit source length `L` and seam `d`, concatenate original middle `[d, L-d]` with a tail-to-head dissolve `[L-d, L] -> [0, d]`; unit length is `L-d`, and its endpoint joins the next unit's original `d` frame continuously. Apply equivalent audio crossfades when source audio is enabled. Quantize seams to frames; reject a source too short to support a valid seam with an actionable media error. Repeat the prepared unit, rather than growing the filter graph with story length.
- [ ] Apply crop/padding, then captions on narration's clock. Normalize narration toward -16 LUFS with true-peak limiting; mix the volume-adjusted bed and duck it from narration. Use existing FFmpeg concurrency, `-progress pipe:2`, actual out-time progress, AAC/H.264/yuv420p/30fps/faststart and an explicit narration-length endpoint. Do not let `-shortest` remove final speech. Probe the partial result and return it for manager promotion only after stream/duration checks pass.
- [ ] Run task tests and existing retention render regressions. Checkpoint renderer files.

### Task 7: Durable asynchronous story jobs and voice previews

**Files:** Create `src/server/story/pipeline.ts`, `src/server/story/jobs.ts`, `src/server/story/previews.ts`, `tests/story-jobs.test.ts`, `tests/story-previews.test.ts`.

**Interfaces:**
- Produce `StoryPipelineAdapters` with `synthesize`, `align`, `prepareBackground`, `writeCaptions`, `render` matching Tasks 4–6; default adapters call real engines. Inject adapters only at this boundary for repeatable job tests.
- Produce `runStoryAttempt(record: StoryRecord, workDir: string, signal: AbortSignal, onProgress: (progress: StoryProgress) => Promise<void>, adapters?: StoryPipelineAdapters): Promise<StoryArtifacts>`.
- Produce `StoryJobManager(store: StoryStore, adapters?: StoryPipelineAdapters)` with `create(inputs: { video: RetainedStoryInput; music?: RetainedStoryInput }, settings: StorySettings): Promise<StoryJob>`, `get(id: string): StoryJob`, `list(): StorySummary[]`, `regenerate(id: string, settings: StorySettings): Promise<StoryJob>`, `cancel(id: string): Promise<StoryJob>`, `idle(): Promise<void>`, and `close(): Promise<void>`.
- Export `RetainedStoryInput = { file: string; originalName: string; hash: string; duration: number; hasAudio: boolean; width?: number; height?: number }` from `src/server/story/jobs.ts`. Manager admission moves validated staged files into the new job's owned inputs; regeneration uses its existing owned files.
- Produce `VoicePreviewManager` with `create(text: string, voiceId: string, speed: number): Promise<VoicePreview>`, `get(id: string): VoicePreview`, `audioPath(id: string): Promise<string>`, `cancelAndDelete(id: string): Promise<void>` and `close(): Promise<void>`.

- [ ] Write failing admission/race tests: concurrent regenerations admit once; 21st pending/running attempt is rejected with 429; cancelling a queued attempt never invokes synthesis; cancellation in each model/render stage waits for process closure; cancelling during final validation prevents promotion; after committed promotion, cancellation preserves the successful artifact. A failed regeneration leaves the old MP4 previewable.
- [ ] Write preview tests: create immediately returns an ID/status before synthesis finishes; only completed previews have audio URLs; fourth simultaneous preview request is rejected; changing/deleting a pending preview aborts it; TTL is exactly 15 minutes; timers are unreferenced/closed.

```ts
assert.equal(secondPreviewWhileFirstIsBlocked.status, 'queued');
assert.equal(renderCallsForCancelledQueuedJob, 0);
assert.equal(manager.get(regeneratedJobId).successfulAttemptId, previousSuccessfulAttemptId);
```

- [ ] Run `rtk proxy npx tsx --test tests/story-jobs.test.ts tests/story-previews.test.ts` and verify expected failure.
- [ ] Assemble stages with one active story attempt and a separate preview queue. Reserve synchronously before persistence awaits; release reservations on every failure. Use statuses from the spec. Set progress bands to synthesis 0–30%, alignment 30–55%, render preparation 55%, encoding 55–98%, validation 98%; advance only from actual completions/out-time, set 100% after promotion. Expose real counters, sanitize errors, check abort at every boundary and serialize cancellation/promotion.
- [ ] Clean only current partial/work outputs after engines stop; retain sources/metadata/previous success. On startup mark interrupted attempts error, retry owned cleanup and expire previews/orphan uploads. `close()` cancels current work and releases timers without starting queued work. Verify captions-disabled attempts never call alignment.
- [ ] Run task tests and store/process tests together; checkpoint these modules.

### Task 8: Private API routes and streaming upload validation

**Files:** Create `src/server/story/uploads.ts`, `src/server/story/routes.ts`, `tests/story-api.test.ts`, `tests/story-uploads.test.ts`; modify `src/server/app.ts`, `src/server/index.ts`.

**Interfaces:**
- Produce `createStoryRouter(services: { store: StoryStore; jobs: StoryJobManager; previews: VoicePreviewManager }): Router`, `createStoryServices(root: string): Promise<{ store: StoryStore; jobs: StoryJobManager; previews: VoicePreviewManager; close: () => Promise<void> }>` and `createStoryUpload(root: string): RequestHandler`.
- Mount `/api/story-videos` after existing local security/JSON middleware and before API 404 handling. Add an optional `story` test integration to `createApp` without breaking current arguments; return story services as an additional property. New shutdown hooks belong in `index.ts` and act only on the created services.
- Implement every route/method/status in the approved spec, registering `/voices` and `/voice-previews` before UUID job routes. Use JSON errors `{ error, code }` with the spec's 400/404/409/413/429/503 statuses.

- [ ] Write failing HTTP tests: background consent false rejects without running engines; fake MP4/audio-only input fails; silent MP4 works; unauthorized/oversized/non-audio music fails; unknown fields/IDs/traversal reject; missing Piper returns 503 only for story operations while `/api/jobs` remains usable. List responses omit scripts and paths; every story response is private/no-store.
- [ ] Pin disconnect/stream-limit tests using an HTTP multipart stream, not only a completed FormData: abort midway through a music part, enforce 100 MiB while streaming with a small injected test cap, stop active writers and remove partials. Test size errors use 413 and unknown file fields fail safely.

```ts
assert.equal(oversizedMusicResponse.status, 413);
assert.equal(privateJobResponse.headers.get('Cache-Control'), 'no-store');
assert.equal(Object.hasOwn(publicJob, 'modelPath'), false);
```

- [ ] Run `rtk proxy npx tsx --test tests/story-api.test.ts tests/story-uploads.test.ts` before implementation.
- [ ] Implement Multer disk storage with generated staging IDs, per-field byte counters and request-abort cleanup. Accept exactly `background`, optional `music`, and `settings`; validate strict JSON/rights before probing or queueing. Use actual MP4/audio probes and hashes; sanitize display names separately from stored paths. Reuse retained assets for JSON regeneration, requiring music rights again if music remains attached.
- [ ] Implement cancellable preview/status/audio/delete routes, story CRUD/status/cancel/regenerate, range-capable preview, named MP4 download and SRT download. Resolve only known successful artifacts; pending/failed jobs without a successful draft return 409. Test Range requests, attachment headers and previous-success access during regeneration. Remove raw stderr, scripts and machine paths from errors. Start maintenance only for instantiated services and close it on server shutdown.
- [ ] Run task tests plus existing API/security/upload tests; checkpoint story-owned route additions and carefully selected integration hunks.

### Task 9: React Story Narrator tab and shared subtitle controls

**Files:** Create `src/client/StoryNarrator.tsx`, `src/client/story-api.ts`, `src/client/story.css`, `src/client/CaptionSettings.tsx`, `scripts/check-story-ui.ts`; modify `src/client/App.tsx`, `src/client/RetentionEditor.tsx`, `package.json`.

**Interfaces:**
- Produce `CaptionSettings({ value, onChange, disabled }: { value: CaptionStyle; onChange: (value: CaptionStyle) => void; disabled: boolean })`; retain existing retention labels and payload behavior when extracted.
- Produce `StoryNarrator()` using Task 1 public contracts. Story API helpers include `uploadStory(form: FormData, signal: AbortSignal, onBytes: (loaded: number, total: number) => void): Promise<StoryJob>`, JSON create/cancel/regenerate/status calls, and preview polling/deletion. Extend no recording-specific uploader contract unnecessarily.
- Add `view: 'story'` to `App` navigation with accessible label **Story Narrator**, matching heading/breadcrumb, and a dedicated form. No changes to the four existing workbench modes or clipping duration controls.

- [ ] Write failing Playwright flows against a local test server: new navigation; exact script/word count/duration estimate; background permission gate; installed/unavailable voices; real returned WAV playback metadata; speed and subtitle settings; music provenance; upload progress/cancel; job polling/errors; Preview/Regenerate/Download; restoration from saved job metadata. Assert generated request preserves the script and uses no clipping minimum settings.
- [ ] Add the stale preview test: begin voice A preview, switch to voice B/speed 1.5 before A completes, then finish A; A's audio must never play or replace B's result. Require deletion/abort of superseded previews and revoke local object URLs on teardown.

```ts
assert.equal(submitted.settings.script, originalScript);
assert.equal(submitted.settings.speed, 1.5);
assert.equal(await page.locator('audio').getAttribute('src'), voiceBPreviewUrl);
```

- [ ] Build the existing app and run the new browser script; capture the missing-tab/control failures before implementation. Add `test:story-ui` using the new script.
- [ ] Implement form/settings, XHR byte progress and abort, voice preview, 1.5-second active-job polling with cleanup, meaningful setup/alignment errors and all actions. Show estimated versus measured durations, previous-success labels during regeneration and terminal cancelling/cancelled states. Persist accepted jobs on the server; stop polling on view teardown without cancelling a job. Give setup links/config IDs without exposing paths or adding publishing controls.
- [ ] Reuse `CaptionSettings` in retention with equivalent control labels and accessible disabled state. For highlighting off retain fade/plain choices; for on use karaoke. Add mobile wrapping and verify individual input bounds, not only document scroll width. Use server-generated successful URLs for preview/download.
- [ ] Run `rtk proxy npm run typecheck`, `rtk proxy npm run build`, `rtk proxy npm run test:story-ui`, `rtk proxy npm run test:ui` and `rtk proxy npm run test:platform-ui`; preserve existing retention browser interactions. Checkpoint only Story Narrator and shared-control changes.

### Task 10: Original samples, live engine validation and final regression review

**Files:** Create `assets/story-samples/short-story.txt`, `assets/story-samples/long-story.txt`, `scripts/smoke-story.ts`, `docs/story-narrator-validation.md`; modify `README.md`, `.env.example`, `package.json`, `docs/retention-engine.md`.

**Interfaces:**
- Add `smoke:story` to run the actual public API pipeline against an isolated data root with local Piper/Whisper/FFmpeg. Default execution uses original bundled stories and generates owned background media with FFmpeg; it does not download background footage or licensed music.
- `smoke-story.ts` writes a `validation.json` with exact script/model/version/settings, measured narration/video durations, alignment coverage, successful attempt/artifact paths, warnings and engine outcomes under an ignored unique `test-artifacts/story-live-<uuid>/` directory.

- [ ] Write short original prose (about 35 words) and longer original prose (at least 250 words, multiple paragraphs), avoiding real-person claims. Generate a 5-second moving background MP4 and optional locally generated audio bed. Ensure the long narration exceeds background length; measure rather than assume these relations.
- [ ] Implement a smoke harness that creates jobs through multipart HTTP, polls actual stage progress, checks every expected spoken token appears once in successful caption alignment, previews/downloads the real MP4 and inspects ffprobe output. Validate short output below 30s and long output above 60s with complete narration. Fail with explicit setup/alignment errors, never a fixture/tone fallback.

```ts
assert.ok(shortResult.narrationDuration < 30);
assert.ok(longResult.narrationDuration > 60 && longResult.narrationDuration > backgroundDuration);
assert.equal(longResult.alignmentCoverage, 1);
```

- [ ] Complete local setup using the Task 4 commands if still needed. Run `rtk proxy npm run smoke:story`; inspect representative frames and caption timestamps and audit generated narration audio where playback is available. Record any unavailable audio-listening capability honestly; do not infer it from successful encoding. If real alignment fails, fix supported alignment behavior with a regression test rather than loosening coverage or silently dropping words.
- [ ] Run final `rtk proxy npm run typecheck`, `rtk proxy npm test`, `rtk proxy npm run build`, `rtk proxy npm run test:story-ui`, `rtk proxy npm run test:ui` and `rtk proxy npm run test:platform-ui`. Use existing retention/media regression tests to verify preservation. Run retention browser checks against a newly completed valid retention fixture when local artifacts are available; report any unavailable precondition explicitly.
- [ ] Update README/environment examples with actual pinned commands, model filenames/registry, default limits, cancellation/cleanup behavior, private asset locations and preview/download usage. Remove the old statement that no Story Narrator exists in `docs/retention-engine.md`. Record measured checks/artifact links and distinguish real-model results from automated doubles in `docs/story-narrator-validation.md`.
- [ ] Request one fresh code review of the complete story change against the approved spec, including the five Review Focus cases. Verify findings, add failing regression tests for real defects, fix important issues and rerun affected checks; do not repeat unrelated expensive checks without a new reason. Perform a final diff/secret/accidental-change check. Leave local services stopped unless explicitly needed for the user's preview. Report completed behavior, actual test results, sample output location and any genuine local setup still outstanding.

## Plan self-review and execution handoff

Spec coverage: UI/actions/settings -> Tasks 1/8/9; Piper/exact text/chunks -> Task 4; Whisper/ASS/SRT -> Task 5; video fit/mixing/codecs -> Task 6; asynchronous progress/cancellation/recovery -> Tasks 2/3/7; uploads/privacy/rights/API -> Task 8; installation/live sample/regressions -> Task 10. All five Review Focus conditions have named tests in their owning tasks.

This plan has not been executed. The user approved the architecture and detailed spec; the next gate is review of this written plan and selection of execution method. Recommend **Native** execution in this session: the tasks share process, timing and job interfaces, and a single implementer can keep those contracts consistent while retaining one independent final review. Subagent-driven execution remains an option if the user prefers per-task independent review and its additional context cost.
