# All qualifying highlights

> Historical report. Current behavior is documented in [Narrative duration policy](minimum-duration-update.md): minimum 30 seconds, auto duration without a maximum, five clips by default, and separate destination export review.

Historical report. The unlimited results and exhaustive cue-ranking policy below are superseded by [Faster focused highlights](focused-highlights-update.md).

The dashboard now requests `clipCount: "all"`. It retains every validated, non-overlapping model suggestion meeting the minimum engagement score instead of taking five or limiting exports to twenty. The default score threshold is 70/100 and can be changed in the existing Highlight recipe panel. Scores are subjective model judgments, not probabilities or guarantees of quality. AI-selected durations and manual start/end adjustments remain available.

## Behavior

- Each transcript cue starts a reading context. The previous 120-context sampling limit is removed. Contexts remain bounded by text size, and inference uses small batches with existing recovery/retry behavior.
- Contexts retain lightweight timeline descriptors; cue arrays, joined text and evidence are materialized only for the active batch. Ranking caches store compact decisions in separate batch files. Returned highlights include only their selected cues.
- Selection filters below-threshold suggestions and resolves overlapping ranges in score order. It does not fabricate enough clips to fill a quota or shorten a stronger story to make room for additional clips.
- Recording uploads, approved imports, analysis, saved jobs and result manifests carry the All setting and score threshold. Old jobs migrate to All; previously generated results remain until analysis is run again. New explicit numeric API settings survive restarts and omitted analyze fields.
- All selected recording highlights can be submitted for FFmpeg generation together. Both the former twenty-clip validation cap and the smaller render-request body limit are removed; render requests have a separate 16 MB body allowance. Each MP4 uses its own validated duration.
- Timestamp analysis retains all qualifying transcript suggestions. Metadata-only Twitch timestamp results retain all usable non-overlapping intervals within the existing search budget. Public VOD clip discovery no longer truncates results to five; its separate legacy 30–60 second filter is preserved.
- Rights tracking, private analysis, draft labels, caption placement, existing platform APIs and publishing restrictions remain intact. No platform downloads or automated publishing were added.

## Configuration and use

```dotenv
DURATION_MODE=auto
HIGHLIGHT_COUNT=all
HIGHLIGHT_MIN_SCORE=70
```

The dashboard always sends `clipCount: "all"`. Older API clients may explicitly send a positive numeric count, and intake requests without a count use `HIGHLIGHT_COUNT`. The analyze endpoint preserves saved settings when count/score fields are omitted.

Open a recording, set **Minimum engagement score** if needed, and click **Analyze stream** again. The new range-cache version reconsiders the complete transcript while keeping completed Whisper transcription. Later threshold changes reuse validated rankings. Preview and adjust boundaries, then use **Generate N clips** to render every selected result.

Start development with `rtk proxy npm run dev`. Start the production build with `rtk proxy npm run build`, followed by `rtk proxy npm start`.

## Modified files

| Area | Files |
| --- | --- |
| Dashboard | `src/client/App.tsx`, `src/client/LivestreamAnalyzer.tsx`, `src/client/PublicTwitchModes.tsx` |
| Analysis and context handling | `src/server/analysis.ts`, `src/server/transcripts.ts`, `src/server/pipeline.ts`, `src/server/models.ts`, `src/server/ranking.ts`, `src/server/timestamp-analyzer.ts` |
| API, jobs, persistence and output | `src/server/app.ts`, `src/server/jobs.ts`, `src/server/store.ts`, `src/server/render.ts`, `src/server/twitch.ts` |
| Settings and types | `src/server/config.ts`, `src/shared/types.ts`, `src/shared/validation.ts`, `.env.example` |
| Node tests | `tests/all-highlights.test.ts`, `tests/analyzer-api.test.ts`, `tests/media.test.ts`, `tests/phase-one-media.test.ts`, `tests/timestamp-analyzer.test.ts`, `tests/transcripts.test.ts`, `tests/twitch-public.test.ts` |
| Browser and local checks | `scripts/check-ui.ts`, `scripts/check-analyzer-ui.ts`, `scripts/smoke-local.ts` |
| Documentation | `README.md`, `docs/auto-duration-update.md`, this report |

## Verification

- `rtk npm test`: 119 passed, zero failed. Coverage includes 60 qualifying recording results, 30 timestamp API results, filtering cached results without retranscription/reranking, 25-clip export validation, 25,000 short-cue contexts, migration and API defaults. Existing real FFmpeg tests verify MP4 codecs, dimensions, synchronization, natural durations, captions, ZIP contents and rights-aware draft metadata. These automated tests use explicit Whisper/Ollama doubles.
- `rtk proxy npm run build`: TypeScript checks, Vite production build and server compilation passed.
- `rtk proxy npm run test:ui`, `test:twitch-ui`, `test:analyzer-ui`: all passed. Browser checks cover All/quality controls, manual boundary edits/render requests, eight timestamp results, copy/export/preview and mobile layouts. Browser APIs are mocked; no clip was published.
- `rtk proxy npm run smoke:local -- test-artifacts/phase-one-live/authorized-sample.mp4 --authorized --rights test-artifacts/phase-one-live/rights.json`: passed with local `llama3.2:latest`, cached real Whisper transcription and real FFmpeg. All four qualifying, non-overlapping suggestions from the 58-second owned sample were rendered with their individual durations. Outputs: `data/live-smoke/jobs/407d52c5-0501-43cc-b5ea-6c047161fc58/exports`. Small-batch recovery completed after invalid model responses. This exercises real model integration but does not prove semantic quality: some short selections and rationales still need context review, including details mentioned outside the selected interval.
- `rtk git diff --check`: passed.

Large recordings require more local inference time because every cue is considered. Full cue coverage is not a guarantee that a finite-context local model will discover every interesting story or choose perfect narrative boundaries. Review quality, context and rights before using a draft.
