# Automatic clip duration update

> Historical report. Current behavior is documented in [Narrative duration policy](minimum-duration-update.md): minimum 30 seconds, auto duration without a maximum, five clips by default, and separate destination export review.

Historical duration-change report. Current clip-count defaults and context coverage are documented in [Faster focused highlights](focused-highlights-update.md).

The recording editor defaults to `durationMode=auto`. Ollama chooses the start and conclusion of each moment from actual Whisper cue boundaries, with no minimum, maximum or target duration. The previous fixed-duration policy is removed. Five non-overlapping highlights remain the default; the dashboard and API accept a count of 1–20.

## Behavior

- Prompts prioritize completed sentences, full questions and answers, setup/payoff, finished stories, reactions, necessary premises and the speaker's meaning. They discourage unresolved references, irrelevant repetition and fragments. A model may decline a context.
- Structured output constrains generation to supplied timestamp values. Validation checks IDs, finite ordered ranges, exact transcript boundaries, interior gaps and original recording bounds. `MAX_HIGHLIGHT_SILENCE_SECONDS=8` is configurable and measures transcript gaps, not clip length.
- Results include numeric seconds in `startTime`, `endTime` and `duration`, plus `title`, `description`, `reasonForSelection` and `engagementScore`. Existing `start`, `end`, `explanation` and `score` remain compatible.
- Each FFmpeg draft uses its own `end - start` duration. Edited exports recompute timing metadata and source transcript excerpts. Existing crop/padding, captions, previews, manual boundaries and regeneration remain available.
- Existing projects load with automatic settings. Analyze again replaces previous duration-policy suggestions. New ranking caches preserve completed no-highlight decisions and reuse Whisper/evidence caches. Changing clip count reselects existing rankings without repeating transcription.
- Transcript-only Twitch/YouTube analysis also loses its former 180-second reading-context ceiling and invalidates older rankings. Official Twitch clip API constraints remain separate.
- Rights records, source provenance, expiration/platform/use checks and draft notices are preserved. Rendering, clip duration and other edits do not establish publishing rights. No downloader or automated social publisher was added.

## Modified files in this update

| Area | Files |
| --- | --- |
| Dashboard | `src/client/App.tsx` |
| Analysis and model recovery | `src/server/models.ts`, `pipeline.ts`, `ranking.ts`, `transcripts.ts`, `timestamp-analyzer.ts` |
| Settings, API and persistence | `src/server/config.ts`, `app.ts`, `jobs.ts`, `store.ts` |
| Export and shared contracts | `src/server/render.ts`, `src/shared/types.ts`, `validation.ts`; added `src/shared/highlights.ts` |
| Configuration and documentation | `.env.example`, `README.md`, this report; historical Phase 1 report cross-reference |
| Verification | `scripts/check-ui.ts`, `scripts/smoke-local.ts`, `tests/media.test.ts`, `phase-one-media.test.ts`, `pipeline-recovery.test.ts`, `timestamp-analyzer.test.ts`; added `tests/auto-duration.test.ts` replacing `tests/short-form.test.ts` |

Other existing workspace changes were retained.

## Verification

- `rtk npm test`: **112 passed, 0 failed**. Tests cover 15-second reactions, complete Q&A, 205.5-second explanations, source edges, invented/out-of-video timestamps, long gaps, seven-clip selection/render validation, no-highlight cache decisions, old cache invalidation and metadata recomputation after edits. Existing rights expiration, restricted-platform, missing-rights, upload, caption and recovery tests pass.
- Real FFmpeg/ffprobe automated media tests validate 15- and 145-second MP4s, 1080×1920 dimensions, H.264/AAC, selected duration, audio/video synchronization, captions, crop/padding and ZIP downloads. These tests use explicit Whisper/Ollama doubles.
- `rtk proxy npm run build`: TypeScript checks and production client/server builds pass.
- `rtk proxy npm run test:ui`, `test:twitch-ui`, `test:analyzer-ui`: all pass. Dashboard checks exercise auto/count settings, analysis submission, displayed durations, manual edits, render submission and mobile layout. Platform APIs are mocked; no clips are published.
- Real local sample check: `rtk proxy npm run smoke:local -- test-artifacts/phase-one-live/authorized-sample.mp4 --authorized --clip-count 5 --rights test-artifacts/phase-one-live/rights.json` passed. It reused the sample's previously generated real Whisper transcript, ran fresh local `llama3.2:latest` analysis and generated four MP4 drafts with FFmpeg. Selected durations were 6.74, 12.22, 3.24 and 4.56 seconds; actual durations differed by less than 0.03 seconds due to frame quantization. Separate ffprobe checks verified dimensions, codecs, synchronized streams and retained rights/draft metadata. Artifacts are in `data/live-smoke/jobs/8a57f348-8ce2-4529-b001-afca89894a71/exports/`.
- `rtk git diff --check`: passes.

## Practical limits

Narrative completeness, engagement scores and generated descriptions/reasons are model judgments. The small local model sometimes chooses weak excerpts or describes surrounding context; the live smoke check establishes engine integration and timing correctness, not consistently strong editorial quality. Preview the original and adjust boundaries or metadata before using a draft. Timestamp validation cannot prove semantic accuracy.

Reading contexts are limited by text size and model capacity, with at most 120 sampled contexts. Oversized requests use overlapping sections and bounded retries; moments spanning those sections may be missed. These input/capacity limits are not duration targets. No platform-specific export duration limit is imposed on private drafts.

No remaining implementation step is required for this automatic-duration update. The broader commentary editor and publishing-review phases documented in the Phase 1 report remain separate work.

## Startup

```powershell
rtk proxy npm run dev
# Or production:
rtk proxy npm run build
rtk proxy npm start
```

Restart an existing server and refresh the dashboard to load the changes. Use Analyze again on older projects; completed transcription is reused. Frontend development uses port 5173; the API uses `PORT` from `.env` (default 3001).
