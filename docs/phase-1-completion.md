# Phase 1 completion report

Historical report: the fixed-duration policy below has since been replaced by [automatic clip durations](auto-duration-update.md). Current recordings default to `durationMode=auto` with configurable highlight count.

## Completed

- Source-rights form and validated persistent records: original creator, source URL, license category, permission/license evidence, license reference, additional conditions, allowed platforms, allowed uses, expiration.
- Own work, licensed work, public domain, six CC 4.0 licenses with applicable conditions, unknown, prohibited publishing, and claimed legal exception requiring human review. Other CC versions can be documented as licensed work with exact terms.
- Expiration and destination/use restriction checks, missing-evidence warnings, safe URL validation and UTC expiration display. A declaration is not legal clearance; an upload or processing checkbox does not prove publishing permission.
- Private recording analysis and existing draft export remain available without established publishing rights. Legacy records default to unknown. The recording workflow does not automatically publish to social platforms.
- Default short-form policy for new uploads: up to five non-overlapping 30–60 second highlights selected by local Ollama for hooks, storytelling, emotional impact and standalone coherence. Model generation is constrained to actual Whisper cue boundaries; the server checks duration, bounds, IDs and transcript support. The model may decline a context.
- Timestamped source excerpts, reasons, AI ranking judgments and heuristic scores in review. Existing natural-duration analysis stays selectable and remains the default for legacy projects.
- Separate short-form ranking cache, including completed no-highlight decisions. Switching policies reuses Whisper/evidence work. Existing recovery for limited Ollama capacity and invalid responses remains.
- Source-rights snapshots and draft-purpose notice in results.json; existing 1080×1920 H.264/AAC, captions, crop/padding, previews, editable boundaries and repeat rendering retained.
- Rights/progress saves serialize per project. Whisper child processes receive the configured FFmpeg directory without changing the parent PATH.
- Existing Twitch/YouTube URL and metadata workflows preserved. No unauthorized platform downloader added. Existing explicit official Twitch clipping is a separate workflow; recording rights records do not cover that flow.

## Files added

- `src/shared/rights.ts`
- `src/client/SourceRightsEditor.tsx`
- `tests/rights.test.ts`
- `tests/short-form.test.ts`
- `tests/phase-one-media.test.ts`
- `tests/whisper.test.ts`
- `docs/phase-1-plan.md`
- `docs/phase-1-completion.md`

## Files modified in this phase

- `src/shared/types.ts`
- `src/client/App.tsx`
- `src/client/api.ts`
- `src/client/styles.css`
- `src/server/app.ts`
- `src/server/jobs.ts`
- `src/server/store.ts`
- `src/server/models.ts`
- `src/server/ranking.ts`
- `src/server/pipeline.ts`
- `src/server/process.ts`
- `src/server/render.ts`
- `tests/media.test.ts`
- `scripts/check-ui.ts`
- `scripts/smoke-local.ts`
- `README.md`

Existing unrelated working-tree changes were retained. Generated fixtures, browser screenshots, build output and local smoke outputs are ignored artifacts.

## Verification

- `rtk npm test`: **108 passed, 0 failed**. Includes expiration boundary, platform restrictions, missing/legacy rights, NC/ND conditions, exception review, simultaneous saves, transcript timing, cached rejection decisions, real captioned vertical draft export, audio/video duration/start-time checks and Whisper child PATH isolation. Automated model-dependent media tests explicitly use test doubles.
- `rtk proxy npm run build`: passed strict TypeScript checking, Vite client build and server compilation.
- `rtk proxy npm run test:ui`: passed recording rights form, CC conditions, default short-form/original-mode behavior, UTC offset display, rendering controls and desktop/mobile checks.
- `rtk proxy npm run test:twitch-ui`: passed existing public discovery and official live clipping UI checks using mocked APIs; no clip was published.
- `rtk proxy npm run test:analyzer-ui`: passed existing Twitch/YouTube timestamp, copy/export, transcript/unavailable and mobile checks using mocked APIs; no platform media acquired.
- Real local verification used an original 58.185-second generated color MP4 and original script spoken by a local system voice for private testing. No source speaker was imitated and no third-party video/music was used. **Whisper base and Ollama llama3.2:latest actually ran.** Ollama selected **12.92–57.20 seconds (44.28 seconds)**. FFmpeg exported 1080×1920 H.264/AAC. Both tracks start at zero; durations are 44.300/44.280 seconds, within one video frame. Rights metadata says draft; automated publishing remains false. This functional sample is not an assessment of highlight quality on all recordings.

Sample: `test-artifacts/phase-one-live/authorized-sample.mp4`

Real output: `data/live-smoke/jobs/68da01cd-6869-46b2-8b4d-6898fa332af6/exports/clip-01.mp4`

Manifest: same directory, `results.json`.

## Remaining work

- **Phase 2:** audio leveling, sentence-aware boundary assistance, export-preview and regeneration improvements, and expanded platform draft workflow. Existing caption/crop/padding/manual-boundary/preview/render features remain operational.
- **Phase 3:** editable transcript-grounded commentary suggestions, microphone recording, explicit source/commentary separation, and original narration/excerpt/licensed-asset assembly.
- **Phase 4:** TikTok/Facebook Reels/YouTube Shorts presets, suggested titles/descriptions/credits/source links, six human publishing-review checks, rights-gated automated publishing if introduced, and a standalone provenance report. The current draft manifest snapshot is not the full Phase 4 report or publishing review.

## Start and verify

From the project directory with the existing `.env` and local engines:

```powershell
rtk proxy npm run dev
```

Open `http://127.0.0.1:5173`. Choose **Analyze authorized recording**. Source rights may be completed before upload or edited/saved after opening a recording. Confirm private-processing authorization separately. New uploads default to the short-form policy.

If Ollama is not running, start it in another terminal:

```powershell
rtk proxy ollama serve
```

Repeat the live verification using the generated private sample and rights record:

```powershell
rtk proxy npm run smoke:local -- test-artifacts/phase-one-live/authorized-sample.mp4 --authorized --short-form --rights test-artifacts/phase-one-live/rights.json
```

Production startup after a successful build:

```powershell
rtk proxy npm run build
rtk proxy npm start
```
