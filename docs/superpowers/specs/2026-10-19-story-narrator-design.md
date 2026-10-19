# Story Narrator design

Date: 2026-10-19
Status: architecture approved; detailed specification awaiting user review

## Intent and success criteria

Add a Story Narrator tab to the existing Cutline application. A creator supplies a story, authorized background MP4, narration voice and optional authorized music, then generates a private vertical MP4 with intelligible narration and synchronized animated subtitles. Preserve all existing navigation destinations, recording projects, clipping duration settings, retention editing, Twitch/YouTube integrations and rights review.

The supplied script is the authoritative text. Do not summarize, rewrite, translate, add commentary or introduce claims. Ollama remains available to existing workflows but is not a dependency for reading the user's text aloud. Rewriting and voice cloning are outside this feature.

Actual synthesized audio determines the video duration. Stories can be shorter than 30 seconds or longer than a minute. Do not apply the clipper's minimum duration, maximum highlight count, highlight analysis or narrative-selection validators to story jobs. Script/upload limits protect local resources; they are not target video durations.

Completion requires functioning UI, real Piper voice preview, asynchronous generation and cancellation, caption alignment, downloadable H.264/AAC output, automated regression checks, documented installation, and a recorded live smoke test using an original test story and generated owned background. Report genuine local setup failures; never substitute tone audio or browser speech for a claimed Piper test.

## Existing architecture and integration boundaries

The project uses React/Vite, strict TypeScript, Express, Multer, Zod and file-backed jobs. The server already validates media with ffprobe, invokes local Whisper and FFmpeg, serializes JSON writes, limits FFmpeg concurrency, builds ASS/SRT captions and restricts access to loopback requests.

Use a new `StoryNarrator` React component and dedicated stylesheet. Add one navigation destination in `App.tsx`; keep the existing workbench and its four modes intact. Extract a shared subtitle settings component from `RetentionEditor` only if it can preserve the current controls and payload exactly. Reuse the existing caption schema and ASS/SRT utilities with an uninterrupted source timeline; do not call retention `buildEdl`, which enforces the clipping minimum.

Introduce focused server modules under `src/server/story/` for routes, persistence/queue, Piper synthesis, alignment and rendering. Put story schemas/contracts under `src/shared/story.ts`. Mount the story router within existing local-host/origin protection and before the API fallback. Keep story records outside the recording `JobStore`; recording migrations must never touch them.

Extend the shared process runner with optional `AbortSignal` support without changing behavior for existing callers. Extend or wrap the existing FFmpeg queue so a cancelled waiter cannot later launch work. Avoid unrelated refactoring and new hosted services.

## Frontend behavior

The new view uses existing panel, input, button, progress, error and preview styling. It contains:

- A labelled multiline script editor with word count, character count and an explicitly estimated duration. Use 150 words/minute divided by the selected speed for the estimate; show actual measured duration once synthesis completes.
- A local background MP4 chooser with the filename and upload progress. Require footage permission before submission. Do not acquire remote videos.
- A selector populated by the server's installed voice catalog, with language, model ID and setup status. Speaking speed ranges from 0.75x to 1.5x, default 1x.
- Preview Voice, which synthesizes at most the first 300 characters ending at a word boundary with the selected voice/speed and plays the returned WAV in an audio element. Label it as an excerpt. Do not auto-play audio on tab load.
- Subtitle enabled, font, position, size, base color, word highlighting and highlight color controls, reusing the existing allowlisted fonts and style bounds. Word highlighting maps to ASS karaoke; disabled highlighting uses plain or subtle fade captions, never invented word timing.
- Background fit choices: Auto, Loop with dissolve, and Slow then loop if needed. Longer footage is trimmed to narration length in every mode. Also expose the existing fill-crop/blurred-padding layout choice and crop position.
- Original background audio gain from mute through 0 dB, default mute. Optional music upload with ownership/license selection, required provenance, permission confirmation and a separate gain control, default -22 dB. Narration stays foreground; mixed background tracks duck beneath it.
- Generate Video, Cancel, Preview, Regenerate and Download MP4 actions. Disable conflicting submissions while a job is active. Keep form text/settings when a request fails. Cancellation shows `cancelling` until the server confirms process termination and cleanup.
- Saved story jobs in the Story Narrator view, separate from Saved recordings. Reopening a job restores its script/settings. Preview and Download refer to the latest successful attempt. During regeneration label that artifact as the previous successful draft until replacement succeeds.

Poll active jobs every 1.5 seconds and stop on terminal state or view teardown. Navigating away does not cancel an accepted job. Abort a browser upload when Cancel is pressed during upload; the server must discard incomplete upload files. Display server stages and completed/total work, with no simulated progress timer.

## Contracts and HTTP API

All routes are under `/api/story-videos`, use local-host/origin checks, return JSON errors with a stable `code`, and send `Cache-Control: no-store`. Preview/download routes serve only known application-generated artifacts.

| Method and path | Contract |
| --- | --- |
| `GET /voices` | Installed catalog entries and Piper/Whisper/FFmpeg readiness. Return public voice IDs/labels/languages/license references; never server paths. Missing Piper is a setup state, not a failure of unrelated clipping routes. |
| `POST /voice-previews` | JSON `{ text, voiceId, speed }`; validate a nonempty excerpt up to 300 characters. Return HTTP 202 with preview ID, status and expiry so pending synthesis can be cancelled. Use the same TTS adapter as full jobs. |
| `GET /voice-previews/:id` | Return preview status/error and, only when complete, measured duration and WAV URL. The frontend polls until completion, then offers audio playback. |
| `GET /voice-previews/:id/audio` | Serve only the completed preview WAV, privately; expired/missing IDs return 404. |
| `DELETE /voice-previews/:id` | Cancel pending preview work, wait for child termination, then delete its directory. Idempotent. |
| `POST /` | Multipart background MP4, optional music and JSON `settings`. Validate files, script, voice and rights before queue admission. Return HTTP 202 with the durable job record. |
| `GET /` | List story summaries: ID, title, creation time, status, duration and successful-artifact availability. Do not include full scripts in list responses. |
| `GET /:id` | Return script, settings, rights declarations, stage, progress, warnings, errors, actual audio duration and available artifact URLs. |
| `POST /:id/cancel` | Cancel the active attempt, returning 202 while shutting down or 200 for an already-terminal attempt. Completed output is preserved. |
| `POST /:id/regenerate` | JSON script/settings/rights snapshot; reuse validated retained footage/music when not replaced. Atomically admit a new attempt only when the job has no active attempt; return 202. Changing uploads uses a new create request. |
| `GET /:id/preview` | Range-capable inline playback of the latest successful MP4. Return 409 when no successful artifact exists. |
| `GET /:id/download` | Download the same MP4 as `story-<job-id>.mp4`. Never publish externally. |
| `GET /:id/captions` | Download the successful attempt's SRT for inspection. Return 409 if unavailable or subtitles were disabled. |

The multipart `settings` JSON contains `{ script, voiceId, speed, subtitles, layout, cropX, fitMode, backgroundMuted, backgroundGainDb, musicGainDb, rights }`. Subtitle settings use the existing caption schema. Gain values are finite numbers from -45 through 0 dB; represent background mute explicitly with `backgroundMuted: true` rather than serializing negative infinity. Rights include footage permission and, when music exists, permission, owned/licensed category and nonempty provenance. Persist these declarations with the result; they are not legal clearance. Regeneration accepts this same JSON contract without multipart files.

Use strict schemas. Initial script limits are 1–30,000 characters and at most 128 KiB UTF-8. Reject whitespace-only content, NUL and non-text control characters; preserve paragraph breaks and punctuation. Respect existing `MAX_UPLOAD_GB` for footage, and enforce music's 100 MiB cap while streaming rather than accepting an oversized music file first. Limit multipart files to the two expected fields and reject unexpected fields. Validate the actual MP4 container/video stream and positive finite media duration, not only its extension/MIME type. Music must contain decodable audio. Silent background footage is valid.

Return 400 for invalid settings, permission or media; 404 for unknown IDs; 409 for conflicting attempts or unavailable artifacts; 413 for limits; 429 for a full bounded queue; and 503 with an actionable setup code when a requested engine/model is unavailable. A later engine failure becomes a durable job error. Do not expose command lines containing script text, raw model payloads or machine paths in public errors.

## Persistence, queue, progress and cancellation

Store metadata in `DATA_DIR/story-videos/<job-id>/job.json`. Job and attempt IDs are server-generated UUIDs validated before path construction. Retain validated inputs under fixed names in that job directory. Each attempt owns `runs/<attempt-id>/work/` and a final artifact directory. Filenames such as `narration.wav`, `captions.ass`, `captions.srt` and `video.mp4` are generated by the application, never derived from user text or upload filenames.

A story record contains schema version, IDs/timestamps, script/settings/rights snapshot, input hashes and media properties, attempt status/stage/progress, measured audio duration, warnings, a bounded sanitized error, and the latest successful attempt ID. Model IDs/version and output codecs/durations accompany a result manifest. Serialize writes using the existing atomic JSON pattern. A new attempt cannot replace the successful pointer until all outputs pass probing and are atomically promoted.

States are `queued`, `synthesizing`, `aligning`, `rendering`, `cancelling`, `complete`, `cancelled` and `error`. Reserve jobs synchronously before the first persistence await. Admit at most 20 active/queued story attempts, with one story attempt running at a time. Story renders share the existing global FFmpeg semaphore with clipping, so adding this tab does not bypass media concurrency limits. Voice previews have one active slot and at most two queued requests; they do not preempt a running subprocess.

Progress reports actual work: upload bytes; completed synthesis chunks; completed alignment chunks; and FFmpeg encoded output time divided by measured narration duration. Overall stage bands may map these measurements to percentages but must not advance while an engine is merely busy. Expose counters as well as stage labels. Mark 100% only after output validation and promotion.

Each attempt/preview owns an AbortController. Check abort before starting every chunk and after acquiring a queue slot. The process runner removes listeners/timers on settlement, resolves/rejects once, terminates the spawned process and waits for `close` before permitting cleanup. Use direct executables or Python `-m` invocation with `shell:false` and hidden Windows windows; avoid detached launchers. If shutdown needs escalation, terminate only the recorded child PID/process tree, never an image-wide kill. Timeouts follow the same termination-before-cleanup path.

Cancellation removes queued work or terminates active Piper, Whisper or FFmpeg. Abort must win over a competing successful exit until final promotion begins; promotion and cancellation must be serialized per attempt. A committed successful attempt is not retroactively cancelled. Cleanup deletes only resolved application-owned work/current partial artifacts after processes have stopped. Preserve retained source assets, job metadata and any prior successful output for regeneration. Cleanup failures become visible warnings and are retried at startup.

On startup, mark nonterminal persisted attempts as interrupted/error with a retry action, remove stale attempt work after verifying ownership, and keep completed artifacts. Never silently mark interrupted work complete or spawn background retries. Expire voice previews after 15 minutes and clean orphaned uploads older than one hour. These periodic maintenance timers must not keep tests or shutdown alive.

## Piper synthesis and exact-text handling

Use the project's local Python environment and the maintained `piper-tts==1.8.0` package. Default voice is `en_US-lessac-medium`, with both `.onnx` and `.onnx.json` files and a recorded model-card/license reference. The model registry is operator-controlled. It may contain additional installed, permitted stock Piper models; users select only registry IDs and cannot submit arbitrary paths, model URLs, voice training or cloning requests. Validate model files at readiness check and synthesis time.

Invoke Python `-m piper` with explicit model/config paths, `--input-file`, `--output-file` and `--length-scale`. Never interpolate the story into a shell command or command-line text argument. Map speaking speed to `length_scale = 1 / speed`. Use a single voice/speed for the whole attempt. Keep normalized synthesis text and its original character-span mapping so normalization cannot drop or duplicate content.

Split at paragraphs and complete sentence boundaries into chunks of approximately 800 characters. If a single sentence is longer, split at a safe word boundary while retaining every token in order; do not silently truncate. Keep UTF-8 text and word spans intact. Piper supplies its ordinary prosody; use short documented sentence/paragraph pauses, without artificial padding to hit any duration target. Chunk boundaries must neither duplicate silence nor clip phonemes. Do not crossfade spoken words.

Normalize chunk WAVs to one PCM sample format/rate and concatenate using an application-generated manifest containing only generated safe filenames. Include necessary boundary pauses in the audio timeline before alignment. Probe the resulting WAV for positive duration, sample rate, channels and readable samples. Fail on missing, empty, corrupt or nonzero-exit TTS outputs. Do not replace failures with synthetic narration. Record exact chunk lengths and cumulative offsets.

Piper and voice installation is an implementation/local-setup task after spec and plan approval. It may require sandbox/network approval. Verify installed help/version and actual synthesis; installation success alone does not establish a working voice preview.

## Caption alignment and readability

With subtitles enabled, run local Whisper with actual word timestamps against the synthesized narration chunks, including their final pauses, then offset each result onto the concatenated audio timeline. Use the exact chunk text as an initial prompt where supported. Require finite, ordered, in-range word times. Audio chunk durations, not estimates from word counts, determine offsets.

Align the original script tokens monotonically to recognized words with Unicode-aware normalization for case, punctuation and explicit equivalent number/contraction forms. Keep the user's spelling and punctuation in captions. Mapping must account for every script token exactly once and exclude hallucinated recognition words. Preserve timestamp spans for supported many-token/one-token equivalences; do not distribute unmatched words across guessed time intervals.

If a chunk cannot be aligned completely, retry that chunk once with the exact script prompt. If still unresolved, stop the subtitled attempt with `CAPTION_ALIGNMENT_REVIEW_REQUIRED`, showing the affected excerpt and a retry/disable-subtitles action. Retain the script and validated inputs. Do not produce a supposedly synchronized result with omitted text, invented speech or fabricated word timings. Disabling subtitles permits narration/video generation without requiring Whisper alignment.

Reuse existing safe ASS escaping, font/style allowlists, readable short groups, punctuation breaks, duration-aware grouping and mobile-safe margins. Build a chronological identity timeline for the entire narration instead of calling clipping/retention duration validation. Highlighting uses verified word timestamps. Export SRT plus alignment metadata for successful captioned attempts. Manual preview remains necessary to assess pronunciations and narrative meaning; recognition matching is not proof of semantic correctness.

## Background fit, rendering and sound

Use narration duration `D` as the continuous master audio/video clock. Output 1080x1920, square pixels, 30 FPS, yuv420p, H.264/AAC with fast-start metadata. Preserve the full narration and finish video within 100 ms of its measured duration, allowing frame/codec quantization. Use a partial MP4 and promote only after ffprobe validates streams, dimensions, durations and synchronized start times.

If background footage is longer than `D`, trim the background. If it is shorter, Auto slows it only when a factor between 1x and 0.75x can fill `D`; otherwise it loops with a 250 ms dissolve at each seam. Explicit Loop always repeats with dissolves; Slow then loop uses at most the same gentle slowing before repeating. Scale dissolve length below half the source segment length for very short footage. Compute the repeated timeline including overlap losses; append enough cycles to cover `D` without losing final narration. Build/reuse a short seamless repeating background unit rather than creating a filter graph proportional to an arbitrarily long story. Never use hard cuts as a hidden fallback; unsupported/invalid fitting produces an actionable error.

Reuse crop/padding filters for orientation. Background visual repetition and speed changes do not change narration speed or captions. Apply subtitles after fitting onto the final video clock. No automatic stock footage fetching, unrelated scene injection or generative visual claims.

Mix narration at the existing -16 LUFS target with true-peak limiting. Original background audio, when enabled, follows the same fit/speed/loop decisions with audio crossfades at seams and fades at the final endpoint. Optional music can loop with a short audio crossfade. Mix the configured background gains into a bed and sidechain-duck it from narration before final limiting. A video without audio needs no silent source track to be invented; optional music can still play. Use a shared final trim to `D` and retain final phonemes/reactions; never use `-shortest` in a way that truncates narration because another input is shorter.

## Privacy, content and rights

All synthesis, alignment, rendering, preview and download remain local to the existing loopback app. Return explicit private/no-store headers; do not expose the data directory through static hosting. Only artifact routes resolve whitelisted paths beneath the owning job. Inspect IDs and real resolved containment before deleting or serving files; reject traversal/symlink escapes. Keep original display filenames as metadata only.

Require footage permission and, when music exists, permission and provenance. Show voice model identity and license reference in the catalog. Do not offer real-person imitation, uploaded voice references or cloning. Preserve the script verbatim in project metadata and the result manifest. No Ollama rewriting, automatic factual elaboration, public links, social credentials or posting endpoints are added. Downloading a draft is not a publishing action or copyright clearance.

Existing recording rights records and their checks remain unchanged. The current local application is not a multi-user authentication system; making it remotely accessible would require a separate access-control design.

## Configuration and installation documentation

Add validated server configuration:

| Variable | Default / meaning |
| --- | --- |
| `PIPER_PYTHON` | Project `.venv` Python; explicit override for another local interpreter. |
| `PIPER_VOICES_DIR` | `data/piper-voices`; contains operator registry and local models. |
| `PIPER_DEFAULT_VOICE` | `en_US-lessac-medium`; must resolve to an installed permitted registry entry. |
| `PIPER_TIMEOUT_MS` | `180000` per synthesis chunk. |
| `STORY_MAX_SCRIPT_CHARS` | `30000`; bounded integer, maximum 100000. |
| `STORY_TTS_CHUNK_CHARS` | `800`; bounded integer from 200 through 2000. |

Use existing FFmpeg/ffprobe/Whisper settings and Python 3.11 in this Windows workspace. README must provide exact PowerShell commands using `rtk proxy`, a pinned Piper installation, model download to the configured directory, both required model filenames, registry setup, and an actual WAV verification command. Document Piper runtime and voice model/dataset licenses separately by linking their primary sources; do not infer a model's usage rights solely from a repository-wide license badge. Keep model binaries, private scripts, uploads and generated media in ignored data paths.

No installed Piper or voice model was found during architecture inspection. Whisper is installed in the project's Python environment. Local execution may require escalation because the sandbox could not start that environment's base interpreter, while the approved read-only check succeeded outside it. Report any installation/runtime restriction separately from application correctness.

## Verification and acceptance

Use test-first implementation for substantial behavior. Automated tests mock only expensive/model boundaries where repeatability requires it; do not use mocked audio as evidence of real local synthesis.

| Area | Required checks |
| --- | --- |
| Script/chunks | Short stories below 30s, long multi-paragraph stories, oversized input, whitespace-only text, Unicode, long sentences, exact token order and no truncation/duplication. |
| Voice/TTS | Registry allowlist, unavailable models/interpreter, actual preview route behavior, speed conversion, multiple chunks, empty/corrupt output, nonzero exits and timeouts. |
| Alignment | Exact script coverage, punctuation/numbers/contractions, repeated words, monotonic chunk offsets, unknown/missing words, retry and explicit review failure; never fabricated word timing. |
| Media | Invalid/fake MP4, audio-only media, silent video, unauthorized footage/music, stream size limits and aborted multipart cleanup. |
| Jobs | Bounded/concurrent admission, cancellation while queued and in Piper/Whisper/FFmpeg, cancel/complete races, restart interruption, cleanup ownership and prior-success preservation on failed regeneration. |
| Real FFmpeg | Narration shorter/longer than footage, trim/slow/dissolve loops, captions on/off, source-audio/music ducking, final audio marker intact, real H.264/AAC streams at 1080x1920, duration and start-time synchronization. |
| Browser | New navigation and all existing destinations, word count/estimate, actual preview playback, voice/speed/caption settings, upload progress, generate/cancel/errors, saved jobs, regenerate, preview/download, desktop/mobile field bounds and no page errors. |
| Regression | `rtk proxy npm run typecheck`, full `rtk proxy npm test`, production build, existing recording and platform browser checks. |

Add a live smoke command that uses an original story and generated owned background MP4. Run actual Piper and Whisper with subtitles, then FFmpeg and ffprobe. Include a short story and a longer story whose narration exceeds the background. Save the input text, effective model/version/settings, measured audio/video durations, alignment coverage, output manifest and MP4 under ignored `test-artifacts/`. Listen to the narration and inspect representative frames/subtitle timing. Keep a runnable smoke fixture and report the artifact paths and any local setup still required. An unresolved real-engine failure is reported as incomplete live validation rather than passing by substitution.

## Primary references checked for this specification

- [Piper 1.8.0 package and Windows wheel](https://pypi.org/project/piper-tts/1.8.0/).
- [Piper CLI installation, input files and voice downloads](https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/CLI.md).
- [Piper CLI at the published 1.8.0 source commit](https://github.com/OHF-Voice/piper1-gpl/blob/639388b6317fc4731e91d53da42aea68fd4166ff/src/piper/__main__.py).
- [Default lessac medium model card and dataset license reference](https://huggingface.co/rhasspy/piper-voices/blob/main/en/en_US/lessac/medium/MODEL_CARD).
