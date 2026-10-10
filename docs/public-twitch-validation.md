# Public Twitch modes: validation

Verified on 2026-10-09. Existing AGENTS.md was preserved.

## Operational paths

| Mode | Implemented paths | Verification and current boundary |
| --- | --- | --- |
| Public VOD discovery | `GET /api/twitch/discover?input=...`, existing `/api/twitch/video` | Real Helix requests and dashboard verified for VOD `2895693134`: broadcaster `caseoh_`, 1 eligible linked clip among 1,000 scanned records / ten pages. Search marked incomplete. Metadata ranking only; no stream media analyzed or downloaded. |
| Viewer live clipping | `/api/twitch/oauth/connect`, `/callback`, `/status`, `/disconnect`; `GET /api/twitch/live?channel=...`; `POST/GET /api/twitch/live/clips`; `GET /api/twitch/live/clips/:id` | OAuth/state/refresh/security, live checks, manual creation, publication polling and persistence pass mocked integration/browser tests. Real Get Users/Get Streams worked for CaseOh and Kai Cenat; both were offline when checked. Real viewer login/publication is not verified and requires the user's grant. No Twitch clip was published. |
| Authorized recording | Existing upload/import, analyze, review, render, MP4/results/ZIP endpoints | Preserved. Generated owned recording passed actual FFmpeg/ffprobe checks for five 1080×1920 MP4s, sync, cropping/subtitles and ZIP. Automated media regression uses explicit Whisper/Ollama doubles; actual spoken-recording transcription remains unverified. |

Register `http://127.0.0.1:5173/api/twitch/oauth/callback` in your Twitch app, open the dashboard at `http://127.0.0.1:5173`, and click Connect Twitch. Sessions request only `clips:edit`; app credentials do not confer broadcaster/editor authority. Tokens stay in server memory, and reconnection is needed after server restart.

## Checks performed

- Full suite: 49 tests passed, including two actual FFmpeg media integration tests. After adding the final concurrent-poll regression, all 48 non-media tests passed; the media path was unchanged by that fix (50 distinct tests verified across runs).
- TypeScript checking, Vite client build and server compilation passed. Vite emitted a nonfatal optional devtools import warning under sandbox Node flags.
- Existing desktop/mobile browser checks and new Twitch mode checks passed. Real discovery was additionally verified through the running dashboard.
- Live-clip polling concurrency, deadline expiry, revoked refresh grants, hourly validation and official thumbnail compatibility regressions passed; independent review found no remaining issues within scope.
- FFmpeg, ffprobe, Whisper and Ollama show Ready in the actual browser. Installed `llama3.2:latest` is the 3.2B model; `.env` now selects it. A real local Ollama call produced a validated structured ranking for synthetic text, with no stream media involved.

Ignored `test-artifacts/` contains screenshots and the real public discovery response. See README.md for installation, callback registration and test commands.
