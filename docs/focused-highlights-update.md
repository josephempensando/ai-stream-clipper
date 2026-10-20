# Faster focused highlights

> Historical report. Current behavior is documented in [Narrative duration policy](minimum-duration-update.md): minimum 30 seconds, auto duration without a maximum, five clips by default, and separate destination export review.

The recording dashboard now offers a maximum of five through eight highlights, defaulting to eight. Selection keeps the strongest validated, non-overlapping suggestions above the existing engagement threshold (default 70/100). It can return fewer than five when there is insufficient strong evidence. Clip durations remain AI-chosen from real transcript boundaries; manual adjustments, captions, FFmpeg exports and rights tracking remain available.

## Actual reduction in analysis work

Previously every transcript cue started an Ollama reading context. Limiting only the final results would not make that analysis faster. Recording and attached-transcript analysis now shortlist at most 24 lightweight contexts before inference. The shortlist retains both recording edges and chooses promising contexts across ordered regions of the source, favoring reaction language. Recording contexts without speech can also carry scene/audio evidence.

With a text model, 24 contexts normally require eight three-context ranking requests. Vision mode uses two-context batches; invalid responses and capacity recovery can add retries. A test with 1,000 cues verifies that only 24 contexts are ranked in eight normal requests, results stop at eight, both timeline edges are considered, and a repeat uses the saved rankings. Contexts remain bounded by text size, not target clip duration.

Shortlisting trades exhaustive search for speed and can miss worthwhile moments. Full Whisper transcription and audio/scene evidence detection still run on first-time recordings, so long uploads can still take time before ranking begins. Their completed caches remain reusable. Shortlist ranking caches use a new version and include the context budget to avoid associating old batch IDs with different contexts. Count and quality changes reuse the new ranking cache.

## Settings and compatibility

```dotenv
DURATION_MODE=auto
HIGHLIGHT_COUNT=8
HIGHLIGHT_MIN_SCORE=70
HIGHLIGHT_CONTEXT_BUDGET=24
```

The dashboard provides **Maximum highlights** choices 5, 6, 7 and 8. The API retains numeric values 1–8 for existing clients. Legacy `clipCount: "all"` and `HIGHLIGHT_COUNT=all` map to eight. Saved unlimited or oversized projects load with a bounded count; valid saved quality thresholds are preserved independently. Existing output files/results remain available until analysis is run again.

Increasing `HIGHLIGHT_CONTEXT_BUDGET` searches more contexts at the cost of additional model work. This setting does not limit clip durations. The existing private-analysis and publishing-rights rules remain unchanged; rendering does not establish clearance.

Restart with `rtk proxy npm run dev`, refresh the dashboard, select a maximum and click **Analyze again** on a saved recording. Production startup remains `rtk proxy npm run build` followed by `rtk proxy npm start`.

## Modified files

- Settings/types: `.env.example`, `src/shared/validation.ts`, `src/shared/types.ts`, `src/server/config.ts`.
- Shortlisting and analysis: `src/server/analysis.ts`, `src/server/transcripts.ts`, `src/server/pipeline.ts`, `src/server/timestamp-analyzer.ts`.
- API/persistence/output metadata: `src/server/app.ts`, `src/server/jobs.ts`, `src/server/store.ts`, `src/server/render.ts`.
- UI: `src/client/App.tsx`, `src/client/LivestreamAnalyzer.tsx`.
- Checks: `tests/focused-highlights.test.ts`, `tests/all-highlights.test.ts`, `tests/timestamp-analyzer.test.ts`, `tests/analyzer-api.test.ts`, `tests/media.test.ts`, `tests/phase-one-media.test.ts`, `scripts/check-ui.ts`, `scripts/check-analyzer-ui.ts`, `scripts/smoke-local.ts`.
- Documentation: `README.md`, historical report notices in `docs/auto-duration-update.md` and `docs/all-highlights-update.md`, this report.

## Verification

- `rtk npm test`: 123 passed, zero failed, including real FFmpeg MP4/ZIP/caption/synchronization checks. Model inference and platform APIs use explicit test doubles in this suite.
- After review found a saved-threshold migration issue, the new regression failed before the fix and passed afterward. `rtk proxy npx tsx --test tests/all-highlights.test.ts tests/api.test.ts tests/jobs.test.ts`: 12 passed after that localized fix.
- `rtk proxy npm run build`: TypeScript, client build and server compilation passed after the migration fix.
- `rtk proxy npm run test:ui` and `rtk proxy npm run test:analyzer-ui`: passed; checks include default eight, choosing five/six, submitted settings, eight timestamp results, natural durations, manual edits and mobile layouts. APIs are mocked; nothing was published.
- `rtk git diff --check`: passed.

The call-count test measures bounded inference work, not elapsed-time improvement on a specific GPU or model. Narrative quality still needs preview.
