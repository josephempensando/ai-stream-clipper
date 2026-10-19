# AI Retention Editing Engine

The engine extends the existing **Analyze authorized recording** workflow. Enable **Auto Edit** and run **Analyze stream**, or open an analyzed recording and choose **Regenerate**. Use the existing maximum-highlight control to request one through eight candidates. Fewer may qualify. No clip length is imposed.

Existing Twitch discovery/live tools, Twitch/YouTube timestamp analysis, approved media imports, MP4 uploads, rights review and ordinary clip exports remain available. There is no Story Narrator implementation in this checkout; none was removed or replaced.

## Analysis and editing

Whisper segment and actual word timestamps survive chunk offsets and caching. Analyze again upgrades pre-retention caches once; subsequent runs reuse the new cache. Older saved projects remain usable with plain captions before re-analysis. Karaoke never uses estimated word timings.

Ollama first proposes natural highlight ranges, then the retention pass identifies hook, setup, escalation, payoff and ending using constrained source cue references. Displayed beat quotes and timestamps come from the original transcript. Invalid references fail validation, retry up to three times, then surface a real job error. Transcript text is treated as data. Incomplete narratives sort below complete narratives, with explicit review recommendations. Scores and narrative completeness are model judgments, not measured retention or guarantees of virality. The source is never reordered.

The opening three seconds are examined using real word timings. Hook overlays quote the source verbatim. With a configured vision-capable Ollama model and `OLLAMA_VISION=true`, the narrative pass can inspect sampled authorized opening frames. Text-only mode explicitly does not infer visual events or faces.

The EDL records chronological keep spans and exact source times/reasons for pause removal, punch-ins, overlays, audio changes and ending treatments. Only model-approved inter-cue gaps of at least 1.2 seconds are shortened, leaving 250 ms speech handles. Spoken repetitions are preserved. Pattern interrupts use measured scene boundaries or model-identified speech emphasis; no periodic animation is forced. At most six subtle 6% punch-ins are applied, separated by at least three source seconds.

Rendering uses one FFmpeg pass with a continuous source video clock and independent audio trims, avoiding the frame-tail padding that AV concat would accumulate. Captions and effects map onto the edited clock. Output is 1080×1920 H.264/AAC at 30 or 60 FPS. A loop is accepted only with a positive narrative assessment and uses a short visual blend while retaining speech. One creator-written CTA can overlay the intact conclusion. Neither mode changes spoken dialogue.

ASS karaoke captions use short word groups, source punctuation, configurable font/color/outline/position/animation and conservative margins. Subtitle corrections keep their original source times and are saved with export edits. Captions are corrected manually, not rewritten by the model. Previews show the original interval and latest actual export; rendering is required to see changed settings.

Dialogue loudness is configurable in LUFS with limiting. Optional music and SFX must be uploaded as owned/licensed assets with provenance and processing confirmation. Music uses speech-sidechain ducking; SFX align to actual selected edit events. Gains are adjustable in dB. No music is downloaded automatically. Each media input is restricted to file/pipe protocols. Rights records, asset provenance, corrections, final EDLs and settings accompany `results.json`; ZIPs include caption/EDL sidecars. Export remains a draft and never authorizes publishing.

## Commands

```powershell
rtk npm run dev
rtk npm run typecheck
rtk npm test
rtk npm run build
rtk npm run test:ui
rtk npm run test:twitch-ui
rtk npm run test:analyzer-ui

# Actual local models and FFmpeg, on your authorized recording:
rtk npm run smoke:retention -- C:\recordings\owned.mp4 --authorized

# Original spoken narration and generated footage, using Windows System.Speech:
rtk npm run smoke:retention -- --generated-owned-sample

# Browser playback/settings checks against a successful smoke artifact directory:
rtk npm run test:retention-ui -- test-artifacts\live-retention-<run-id>
```

The live smoke script requires installed Whisper and Ollama and a cached/downloadable Whisper model. It records actual model names and generated-owned-sample provenance in `validation.json`. It does not replace inference with fixtures. Browser tests intercept only the export submission after checking real source/export playback metadata.

Automated retention tests cover unsupported/reordered cue references, retries, first-three-second hook support, short reactions, podcast Q&A, long stories, quiet explanations, gaming/reaction fixtures in the existing suite, word offsets, source-bound caption corrections, old cache upgrades, audio provenance/approval, optional audio/loop rendering, stale export metadata, 30/60 FPS encoding, decoding, AV timing and repeated fractional-frame cuts. External-model responses in automated tests are explicit doubles.

## Dependencies and practical limits

No new npm or Python dependencies were added. Rendering requires FFmpeg with libx264, AAC, libass, zoompan, loudnorm, sidechaincompress and alimiter; the installed bundled binary was exercised. Whisper and the configured Ollama model remain required for new analysis. Small models can select weak excerpts even when their JSON is valid; review the narrative assessment and source, adjust to complete cue boundaries and Regenerate. Evidence grounding prevents invented timestamps/quotes, not every possible semantic misinterpretation.

Face tracking, subject-following crops, independent emotion/camera-motion classifiers and automatic licensed B-roll retrieval are not implemented. Safe blurred padding or manual crop positioning is used. Richer visual interpretation requires a vision-capable Ollama model; no such model was installed by this change. A licensed/user-owned music or SFX file is required to enable those optional tracks. Platform UI overlays vary, so verify safe placement in the destination app.

## Changed files

Verified on 2026-10-19: `typecheck` and production `build` passed; all **133 automated tests** passed. Dashboard desktop/mobile, Twitch workflow, Twitch/YouTube analyzer and retention browser checks passed. Twitch/analyzer scripts used a running local frontend at port 5180 and mocked platform APIs, with no publishing. Retention browser checks loaded actual source/export videos, then intercepted the export submission for payload assertions.

Actual Whisper `base` and Ollama `llama3.2:latest` completed the owned spoken-sample pipeline, produced an EDL, and rendered a decodable synchronized export. Artifacts: `test-artifacts/live-retention-e5bae084-5bbd-47c6-bcba-6d027c83f37b/`, including `validation.json` and retention desktop/mobile screenshots. A small-model run identified a weak narrative; the UI flagged it rather than substituting a fabricated hook/payoff. Render fixtures separately exercised 30/60 FPS, music, SFX, loop blending, caption corrections and repeated fractional-frame cuts.

- UI: `src/client/App.tsx`, `src/client/RetentionEditor.tsx`, `src/client/retention.css`.
- Contracts: `src/shared/types.ts`, `src/shared/validation.ts`, `src/shared/retention.ts`.
- Engine: `src/server/analysis.ts`, `models.ts`, `pipeline.ts`, `jobs.ts`, `app.ts`, `render.ts`, `retention.ts`, `retention-captions.ts`, `retention-render.ts`.
- Verification: `tests/retention.test.ts`, `retention-api.test.ts`, `retention-render.test.ts`; `scripts/check-ui.ts`, `check-retention-ui.ts`, `smoke-retention.ts`.
- Commands/docs: `package.json`, `README.md`, this guide, `docs/superpowers/plans/2026-10-19-retention-engine.md`.

The pre-existing user modification to `.env.example` was left intact.
