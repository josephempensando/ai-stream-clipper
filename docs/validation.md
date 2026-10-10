# MVP validation — 2026-10-09

## Passed

- `npm test`: 26 tests passed, zero failures/skips. In this restricted Windows sandbox the command ran with Node preserve-symlink flags and a workspace npm cache.
- `npm run typecheck`: passed.
- `npm run build`: passed; Vite emitted a non-fatal unresolved optional `@vitejs/devtools/config` warning under the sandbox flags.
- Headless Edge desktop (1440 px) and mobile (390 px): dashboard renders, disabled engine gating, VOD URL validation, navigation and mobile overflow checks passed; no page JavaScript errors.
- Owned generated 300-second recording: multipart upload, permission rejection, three audio chunks with absolute transcript offsets, analysis/cache reuse, five non-overlapping highlights, five 30-second 1080x1920 MP4s, video/audio stream timing, results manifest, individual downloads, ZIP contents, crop and synchronized burn-in subtitles passed with actual FFmpeg/ffprobe.
- Actual Helix metadata request: VOD **2895693134**, broadcaster **caseoh_**, duration **3h55m37s**. The supplied standalone **289563134** is a distinct ID. Production API returns metadata-only access and the authorized-recording requirement.

## Validation boundaries

Whisper and Ollama were **not installed/available**. The automated media test uses explicitly injected test-only transcription/ranking doubles, and manifests identify both models as `test-double`. The separate actual-engine `smoke:local` command stopped at its dependency readiness check; no actual model inference is claimed. Twitch clip creation/download contracts were mocked; no clip was published. The target Twitch VOD's video bytes were **not acquired or analyzed**.

Preview of the final build was started on **http://127.0.0.1:3002** because another API occupied port 3001. The existing process could not be stopped by the restricted sandbox. Default development ports remain frontend 5173/API 3001; restart/stop an existing API before using those defaults.

## Artifacts

- `test-artifacts/dashboard-desktop.png` and `dashboard-mobile.png`.
- Latest full media validation: `test-artifacts/media-2d33491a-3929-4e4b-b5b2-bdd6051c4ec4/`; generated source plus `jobs/<job-id>/exports/clip-01.mp4` through `clip-05.mp4` and `results.json`. Separate `crop-subtitle-test/` preserves the original five-file export set.

Artifacts are ignored by Git. Windows setup and actual local-engine verification instructions are in README.md.
