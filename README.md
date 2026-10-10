# Cutline — AI Livestream Highlight Analyzer

A local React/Vite and Node.js/TypeScript dashboard for finding **up to five evidence-supported livestream highlight timestamps**. Attach a legitimately obtained transcript for Twitch or YouTube and let local Ollama choose each moment’s natural start and end, then open the original stream and clip manually. Twitch can also discover existing public clips without a transcript. Timestamp analysis does not download platform videos or generate MP4s. The existing authorized-recording workflow remains available with Whisper, Ollama and FFmpeg.

## Quick start: timestamp analysis

If dependencies and local Ollama are already installed, set the server `.env` credentials below, restart the backend, and run:

```powershell
rtk proxy npm.cmd run dev
```

Open **http://127.0.0.1:5173** and select **Analyze livestream highlights**. Paste a Twitch VOD/schedule URL or YouTube URL, then click **Analyze Highlights**. Review the evidence/confidence labels, preview or open the original at each timestamp, and copy individual/all times. **Export JSON** and **Export CSV** download analysis text only. Scores express ranking judgments, not calibrated confidence probabilities.

Twitch needs `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` (or an existing server token). YouTube needs a server `YOUTUBE_API_KEY` for an enabled [YouTube Data API v3](https://developers.google.com/youtube/v3/docs/videos/list) project. YouTube transcript ranking uses `TRANSCRIPT_OLLAMA_MODEL=llama3.2` at the configured local Ollama endpoint (default `http://localhost:11434`); install it with `rtk proxy ollama pull llama3.2`. Keep all credentials in server `.env`, never `VITE_*` variables. Whisper/FFmpeg are only needed for the authorized-recording workflow.

Without a YouTube API key, the app reports the missing configuration. Without a transcript or known archived video duration, it displays an honest unavailable state. A public link alone cannot support YouTube highlight analysis.

## Supported URLs and transcript evidence

- Twitch: `https://www.twitch.tv/videos/2895693134` or `https://www.twitch.tv/caseoh_/schedule?vodID=2895693134`.
- YouTube: `https://www.youtube.com/watch?v=VIDEO_ID`, `https://www.youtube.com/live/VIDEO_ID`, or `https://youtu.be/VIDEO_ID`.
- Attach a permitted `.srt`, `.vtt`, `.json` or timestamped `.txt` file to a Twitch or YouTube URL and confirm permission. Limits: 2 MB and 50,000 cues. Times must use the original video timeline and fit its official duration; invalid boundaries are rejected rather than clamped. Mapped VTT timelines must be converted first. The highest-scoring complete moments are selected first; a strong long moment is preserved even when shorter overlapping suggestions could fill more slots.

JSON accepts an array, or `{ "segments": [...] }`, with entries such as `{ "start": 60, "end": 105, "text": "The setup and payoff..." }`; numeric times are seconds. TXT supports explicit ranges (`00:01:00 --> 00:01:45 The setup and payoff...`) or one timestamp per line. For point-stamped text, each next timestamp closes the previous line; a final line without an end boundary is excluded.

Without a transcript, Twitch [Get Clips](https://dev.twitch.tv/docs/api/reference/#get-clips) searches the VOD's creation-date range, refines saturated ranges and uses an all-date fallback when necessary, within a 30-page request budget. Only exact matching `video_id` and broadcaster IDs qualify. Returned [`vod_offset`](https://dev.twitch.tv/docs/api/clips/) is the original **start**; end is start plus actual duration. Missing offsets/IDs and out-of-bounds intervals are excluded. Up to five non-overlapping clips are ranked with no duration preference. Rankings use popularity and titles, and are labeled metadata-only. Search-limit warnings acknowledge clips that might remain undiscovered.

Attach a transcript for either Twitch or YouTube to let Ollama analyze the best clip range. The model chooses exact cue start/end boundaries that preserve setup and payoff, without a duration restriction. Overlapping reading contexts contain up to 6,000 text characters; these bound model input, not target clip length. Up to 120 contexts spread across the transcript are analyzed in small local batches. Moments longer than a reading context may be missed. Output IDs, times, scores and transcript support are validated before non-overlapping selection, with at most eight seconds between interior cues. Rankings use a new cache version under `data/analyzer-cache`; transcript association/timing is supplied by the user and is not independently verified against audio/video. Fewer than five results are shown when evidence is insufficient. Preview the original, copy or export the suggested range, then manually clip it. Seek links use whole seconds; copied/exported times preserve fractional boundaries.

## Windows PowerShell setup

Use Node.js 22.13+ (or a newer supported LTS), Python 3.11, FFmpeg/ffprobe and Ollama. Python 3.11 is recommended for Whisper/PyTorch compatibility. Install tools using their official installers or, if Winget is available:

```powershell
winget install OpenJS.NodeJS.LTS
winget install Python.Python.3.11
winget install Gyan.FFmpeg
winget install Ollama.Ollama
# Reopen PowerShell after installation so PATH updates take effect.
```

Run repository commands through `rtk` as required by AGENTS.md. If RTK is unavailable, install it separately or execute the underlying commands directly in your own terminal.

```powershell
rtk proxy npm.cmd ci
rtk proxy py -3.11 -m venv .tools/whisper-env
rtk proxy .tools/whisper-env/Scripts/python.exe -m pip install --upgrade pip
rtk proxy .tools/whisper-env/Scripts/python.exe -m pip install -U openai-whisper
rtk proxy ollama pull llama3.2
rtk proxy ollama serve
```

Keep Ollama running in its own terminal (the Windows app may already run the server). Copy `.env.example` to `.env` only if `.env` does not exist, set `WHISPER_PATH` to the **absolute path** of `.tools/whisper-env/Scripts/whisper.exe`, and configure any other settings. Whisper itself requires FFmpeg on PATH; the API also has bundled `ffmpeg-static`/`ffprobe-static` fallbacks installed by npm. Override `FFMPEG_PATH` and `FFPROBE_PATH` for system binaries. Static binary installation needs network access; binaries are not downloaded on each run.

```powershell
rtk proxy powershell -NoProfile -Command 'if (!(Test-Path -LiteralPath .env)) { Copy-Item -LiteralPath .env.example -Destination .env }'
rtk proxy npm.cmd run dev
```

Open **http://127.0.0.1:5173**. The API runs on **127.0.0.1:3001**. Whisper downloads its chosen model on first use; subsequent transcription is local. CPU inference on long recordings can take considerable time. Health checks confirm executable/model availability, not GPU acceleration or first-use Whisper model readiness.

Vite proxies `/api` to the backend's `PORT`. If using an already-running API on a different port, set `DEV_API_PORT` in `.env` (for example `DEV_API_PORT=3003`). This changes the dashboard's connection without changing where the backend itself listens. For a fresh `npm run dev`, align `PORT=3003` with `DEV_API_PORT=3003`, or remove the proxy override to use the default backend port. Restart the backend after changing its `.env` settings; refreshing status alone does not reload server configuration.

## Choose a workflow

The dashboard preserves the existing design and provides four modes:

- **Analyze livestream highlights** (default): resolve official source metadata, identify existing Twitch clip offsets or analyze a supplied YouTube transcript, and return genuine timestamps with evidence labels. Copy/export analysis and manually review the original stream. No platform video downloads or MP4 exports occur in this mode.

- **Discover existing VOD clips**: enter a VOD URL. Helix Get Videos resolves the broadcaster; Get Clips paginates up to ten 100-item pages and filters exact `video_id`. Results contain up to five existing 30–60 second clips ranked by logarithmic view counts and descriptive/reaction title wording. Actual counts, thumbnails, duration, views, metadata score, embedded previews and Twitch links are shown. No video/audio AI analysis or public clip downloads occur. Twitch limits a paginated query to approximately 1,000 results; incomplete searches are disclosed. Clips without a VOD ID cannot be matched, and later-created or less-viewed clips may lie beyond the search limit.
- **Create live Twitch clips**: connect your viewer account, enter a channel login/profile URL (for example `caseoh_` or `https://www.twitch.tv/kaicenat`), and check live status. Click **Create live clip now** to publish a recent live moment through the official viewer Create Clip API. Requested duration is 30–60 seconds; Twitch's approximate capture window may be shorter near stream boundaries. Follower/subscriber restrictions, disabled clips, account bans/timeouts and unclippable categories are enforced by Twitch. Saved IDs/links show pending, published or unconfirmed status. This mode cannot retrospectively clip a VOD or download its media.
- **Analyze authorized recording**: upload an MP4 or import an operator-approved HTTPS source you have permission to process. Existing Whisper/Ollama analysis, timestamp review, FFmpeg vertical exports, subtitles and ZIP downloads remain available. Public discovery/live clipping do not require these local AI engines.

## Analyze an authorized recording

1. Choose an MP4 and confirm permission to process it privately. This processing confirmation and possession of a file do not establish publishing rights. Record the original creator, source URL, rights category, permission/license evidence, license conditions, allowed platforms/uses, and expiration in **Source rights**. Incomplete or unknown publishing rights do not block private analysis. Upload it; the server verifies its video stream and duration. If matching a VOD excerpt, set the excerpt's starting VOD second before upload. Recording timestamps remain absolute within the uploaded file; `results.json` also contains the corresponding VOD offsets.
2. Ensure all local engines are ready, then click **Analyze stream**. Progress reports cached chunk transcription, audio/scene analysis and model ranking.
3. All recordings use **Auto · AI determines each clip duration** (`durationMode=auto`). There is no fixed minimum or maximum highlight length: a reaction can last 15 seconds, while a complete explanation can exceed two minutes. Ollama chooses actual transcript boundaries around completed sentences, whole questions and answers, jokes, reactions and finished stories, preserving the speaker's meaning. It favors hooks, emotional impact and standalone coherence, and avoids irrelevant repetition or silence. Unsupported timestamps and long interior silent gaps are rejected; a context without a suitable moment may return no highlight. **Number of highlights** defaults to five and is configurable from 1–20. Results show timestamps, each selected duration, source excerpts, selection reasons, engagement judgments and heuristic evidence scores. Preview highlights, edit start/end seconds, and select clips. Manual ranges must stay within the recording and not overlap; review edits for sentence continuity and context before exporting.
4. Choose blurred padding (default) or fill-crop with a horizontal position. Optionally burn in transcript subtitles. Captions use a smaller font at the bottom center with a safe margin; long transcript passages are split into short captions, with timing estimated within each Whisper segment. Generate clips and download MP4s, `results.json`, or ZIP. ZIP includes SRT sidecars when enabled. Generate existing clips again to apply subtitle styling changes; analysis does not need to run again.

Exported MP4s follow selected ranking order (`clip-01.mp4`, `clip-02.mp4`, …). Fewer files are returned when the recording cannot supply the requested number of valid non-overlapping highlights. Each FFmpeg export uses its own start time and exact `end - start` duration. Output is 1080×1920, 30 fps, H.264/AAC with fast-start metadata. Trimming uses one input timeline for video and audio; captions intersect the chosen range and rebase to clip time.

Set `DURATION_MODE=auto`, `HIGHLIGHT_COUNT=5`, and optionally `MAX_HIGHLIGHT_SILENCE_SECONDS=8` in `.env`. The silence threshold checks gaps between transcript cues; it is not a clip-duration limit or an acoustic silence classifier. The dashboard can override the count per project. `/api/jobs/:id/analyze` accepts `{ "durationMode": "auto", "clipCount": 5 }`; upload and approved import accept the same settings. Highlight JSON includes numeric seconds in `startTime`, `endTime`, and `duration`, plus `title`, `description`, `reasonForSelection`, and `engagementScore` (0–100). Existing `start`, `end`, `explanation`, and `score` fields remain compatible. Timestamps and duration are computed from validated source boundaries, never invented by metadata generation. MP4 drafts have no platform duration cap; any future destination limit must be an explicit export setting and must not silently truncate an analyzed story.

### Copyright-aware editor: Phase 1

Rights records are declarations and supporting references, not verified licenses, copyright certification, Content ID checks, or legal clearance. **Save rights record** updates an existing project without repeating transcription. Older projects and uploads without a rights record remain **unknown**. Expired permission, omitted platforms/uses and missing evidence appear as publishing issues. Private analysis and MP4 draft exports remain available, including when publishing rights are unknown or prohibited; this does not assert a legal right to process any particular source.

The form supports own work, licensed work, public domain with supporting evidence, Creative Commons, unknown rights, prohibited publishing and claimed legal exceptions. A claimed exception always requires human review. Built-in Creative Commons choices are the six **4.0** licenses: credit/source/license links and changes, NonCommercial, NoDerivatives and ShareAlike requirements are shown as applicable. Checking an allowed-use box cannot override NC/ND restrictions. Earlier or jurisdiction-specific CC licenses should be recorded under **Licensed or written permission**, with their exact terms and evidence; the app does not assume they equal 4.0. See [Creative Commons' license descriptions](https://creativecommons.org/cc-licenses/) and the actual license supplied with the source. Other rights, such as music, privacy and publicity, may need separate permission.

`GET /api/jobs/:id/rights` returns the record and assessment; optional `platform=tiktok|facebook-reels|youtube-shorts` and `use=...` queries check the declared scope. `PUT /api/jobs/:id/rights` validates and saves the record. Dates accept ISO timestamps with offsets and display in UTC. Rights saves and processing progress serialize per project. Automatic-duration decisions, including no-highlight decisions, have a versioned cache separate from older duration-policy rankings; completed Whisper chunks are reused. Changing the requested count reselects from cached rankings. Use **Analyze again** to replace old fixed-duration suggestions. Short duration, captions, cropping and commentary never establish publishing rights.

All recording exports are **drafts**. `results.json` includes the source-rights snapshot, assessment and snapshot time; rendering never clears publication. No recording-to-social-platform publisher is enabled. Existing official Twitch live/editor clip creation remains a separate explicit user action with Twitch's authorization checks; the Phase 1 rights form does not cover that separate workflow.

**Remaining phases:** Phase 2 adds audio leveling and sentence/boundary assistance plus improved export preview/regeneration; Phase 3 adds editable grounded commentary, microphone recording and licensed-asset assembly; Phase 4 adds destination presets, suggested metadata, the human publishing-review checklist, publishing guards and a standalone provenance report. Current crop/padding, captions, manual boundaries, previews and repeat rendering remain available.

## Twitch access and viewer OAuth

The supplied URL refers to **2895693134**, while the separate supplied ID **289563134** is different. The URL ID is the editable dashboard default. The parser also accepts the supplied malformed `https//` scheme.

Register an application in the [Twitch developer console](https://dev.twitch.tv/console/apps). Set `TWITCH_CLIENT_ID` plus either `TWITCH_CLIENT_SECRET` (server obtains a client-credentials app token for metadata) or `TWITCH_USER_ACCESS_TOKEN`. Get Videos returns metadata; the dashboard embeds Twitch playback. **Neither metadata nor a publicly viewable embed grants access to video bytes.** Automatic analysis remains disabled until an authorized recording is uploaded/imported.

For the new **Connect Twitch** button, set both app credentials and register this exact OAuth redirect in the Twitch developer console:

```dotenv
TWITCH_REDIRECT_URI=http://127.0.0.1:5173/api/twitch/oauth/callback
TWITCH_APP_ORIGIN=http://127.0.0.1:5173
```

Use the dashboard at **http://127.0.0.1:5173**, matching the registered hostname. Restart the backend after changing `.env`. Connect requests only `clips:edit` through the [authorization code grant](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#authorization-code-grant-flow). State is random, single-use, expires after ten minutes and is bound to an HTTP-only browser cookie. Redirects must use the same configured loopback origin and fixed callback path; caller-provided return URLs are ignored. The server exchanges/validates tokens, refreshes expired sessions and validates active sessions at least hourly. Access/refresh tokens remain in server memory; only an opaque HTTP-only SameSite=Lax session cookie reaches the browser. Sessions expire after 24 hours and require reconnecting after server restart. Disconnect clears the local session; revoke the app in Twitch account settings to withdraw the grant itself.

For production build served directly by the backend, set both origins to the backend's configured `PORT` (for example callback `http://127.0.0.1:3001/api/twitch/oauth/callback` and origin `http://127.0.0.1:3001`) and register that exact callback. This remains a loopback-only personal tool.

Live status is checked again server-side before each Create Clip request. Creation is never blindly retried after timeouts. Publication is checked using Get Clips for up to 60 seconds; unconfirmed clips remain visibly unconfirmed. Helix rate-limit headers establish a cooldown and `429` responses include `Retry-After`; the UI waits before retrying. IDs, links and statuses persist in `data/twitch-live-clips.json`, filtered to the connected creator account. No OAuth tokens are written there.

Public app credentials grant metadata access only. Connecting with `clips:edit` grants viewer clipping only, and does not establish broadcaster/editor authority.

## Optional broadcaster/editor VOD clipping

The separate manual **Authorized Twitch clip** panel uses the documented [Create Clip From VOD](https://dev.twitch.tv/docs/api/reference/#create-clip-from-vod) and [Get Clips Download](https://dev.twitch.tv/docs/api/reference/#get-clips-download) endpoints. Obtain a user token using Twitch's [authorization code flow](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#authorization-code-grant-flow), requesting `channel:manage:clips` as the broadcaster or `editor:manage:clips` as a channel editor. Put it in the server `.env`; never use a `VITE_*` variable for secrets.

The server validates token client/identity/scopes; Twitch enforces editor membership. Clip end is the integer `vod_offset`, and duration has 0.1-second precision. This MVP restricts manual clips to 30–60 seconds. It polls official download availability for up to a minute; permission failures are shown, links may be absent, and returned links expire. Creation can publish a clip on Twitch, so the dashboard requires an explicit user action. This advanced panel still uses the separately configured `TWITCH_USER_ACCESS_TOKEN`; replace expired advanced tokens in `.env` and restart. It is separate from viewer OAuth and does not enable a full-VOD downloader. Official clip links can be uploaded for local rendering only with permission.

## Authorized recording analysis and operational limits

- Extract mono 16 kHz audio in ten-minute chunks; run Whisper locally with JSON timestamps and cache completed chunks. Do not infer quality from loudness alone.
- Measure per-second RMS, sample low-resolution scene changes, and search reaction/laughter language cues. These are heuristics; laughter is **not** independently classified.
- Send at most 120 overlapping reading contexts, bounded by transcript text size rather than seconds, to Ollama in small batches. Structured generation uses real cue start/end values; validation rechecks every interval against the source transcript and original media duration. The model chooses natural clip durations; score-first selection keeps up to the requested number of non-overlapping moments without shortening a stronger story to fill the quota. Long-stream context sampling is approximate, not exhaustive semantic understanding. Narrative completeness is a model judgment and needs human preview; timestamp validation cannot prove semantic completeness.
- Completed transcription and evidence caches are retained when switching from fixed windows to model-chosen ranges. Previous fixed-window rankings are ignored; use **Analyze again** for existing results.
- Ollama requests default to a 4K context (`OLLAMA_NUM_CTX=4096`, minimum 2048). Oversized text is split into overlapping complete cues; clip duration remains model chosen. Memory/time limits retry with smaller contexts. Invalid batch responses retry in smaller requests, with at most two attempts per isolated context. Required result keys prevent duplicate candidate IDs during structured generation; all returned timing is still validated.
- Successful decisions are saved as they complete, including contexts with no suitable highlight. If some contexts remain invalid, valid highlights are returned with analysis notes; **Analyze again** retries missing work using cached transcription and rankings. An unavailable model or persistent memory failure stops further requests, retaining completed work. If no contexts can be analyzed, a clear retry/setup error is shown; valid no-highlight decisions display an empty review. Splitting reading contexts may miss longer moments spanning those contexts.
- Default text model uses transcript and scene evidence. For visual interpretation, set `OLLAMA_MODEL=llava` and `OLLAMA_VISION=true`, install that model, and restart. Sampled frames are passed only to a configured vision model; text mode never claims to have interpreted images.
- A single processing queue admits at most 20 active/waiting jobs. `FFMPEG_CONCURRENCY` defaults to 1 (maximum 4). Stage/batch progress is shown; rendering does not estimate per-frame remaining time.
- Jobs survive restarts; interrupted jobs show a retryable error. Caches are keyed by media hash, model/settings and algorithm version. No automatic disk-retention policy exists; stop the server before removing old `data/jobs` or `data/cache` directories. WAV intermediates are removed after successful transcription.

## Security and approved sources

The server binds to loopback and rejects foreign browser origins. This is a single-user local tool, **not a public hosting service**. Credentials remain server-side. MP4 uploads are disk-streamed and capped at 20 GB by default (`MAX_UPLOAD_GB`). Some recordings named `.mp4` contain MPEG-TS; the uploader detects these and repackages their video and audio into a real MP4 with FFmpeg stream copy, without re-encoding. The result is validated before saving, and temporary files are removed on failure. Other non-MP4 containers still require conversion. Treat local media as untrusted input and keep your FFmpeg distribution updated.

Approved URL import is opt-in: set comma-separated **exact** `APPROVED_MEDIA_HOSTS` in server `.env`. Only HTTPS/port 443 is accepted; user-info and IP-literal URLs are rejected. All DNS answers must be public, and the chosen address is pinned to the TLS connection while retaining hostname verification. Redirects are rejected, downloads are size/time limited, and FFmpeg/ffprobe only receive local media with file/pipe protocols. An allowlisted source is an operator trust decision; the user still must hold media rights.

## Commands and automated validation

```powershell
rtk proxy npm.cmd run typecheck
rtk npm test
rtk proxy npm.cmd run build
rtk proxy npm.cmd start
# Production dashboard: http://127.0.0.1:3001
rtk proxy npm.cmd run test:media
rtk proxy npm.cmd run test:ui
# With a running dashboard (development or production):
rtk proxy npm.cmd run test:twitch-ui -- http://127.0.0.1:5173
rtk proxy npm.cmd run test:analyzer-ui -- http://127.0.0.1:5173
```

`test:ui` builds upon an existing frontend build and runs headless Edge on Windows if installed. Otherwise install Playwright Chromium (`rtk proxy npx playwright install chromium`). It starts an isolated temporary API on an available port. To test an already-running production server: `rtk proxy npx tsx scripts/check-ui.ts http://127.0.0.1:3001`.

The Node test suite covers source URL parsing, exact Twitch offsets/missing IDs, insufficient clips, saturated pagination/date refinements, transcript formats/bounds/coverage, YouTube metadata errors, cached model-output validation, permission/size/origin checks and safe CSV exports, alongside the existing OAuth, SSRF, queue, persistence, subtitle and media tests. It generates an entirely owned synthetic recording, runs real FFmpeg/ffprobe, checks five MP4s and ZIP contents, and separately checks crop/subtitle rendering. **Whisper and Ollama use explicit test-only doubles in this automated media test.** Platform APIs are mocked; tests never publish or download platform clips. `test:twitch-ui` checks the preserved public/live workflows. `test:analyzer-ui` checks timestamp/copy/export/preview controls, short clips, YouTube transcript/unavailable states and mobile layout using mocked APIs. Browser checks save screenshots without publishing a clip.

For real local-engine end-to-end validation, provide your own spoken recording:

```powershell
rtk proxy npm.cmd run smoke:local -- C:/recordings/my-owned-stream.mp4 --authorized
```

This command requires actual Whisper/Ollama readiness and runs transcription, ranking and rendering, storing output in `data/live-smoke`. To generate tone/video media for FFmpeg diagnostics only: `rtk proxy npm.cmd run demo:recording`. Synthetic tone media is not a meaningful speech/highlight quality test.

For Phase 1 verification with a spoken sample you may process privately:

```powershell
rtk proxy npm run smoke:local -- C:\path\sample.mp4 --authorized --clip-count 5 --rights C:\path\rights.json
```

The JSON file uses the rights form's fields. `--authorized` confirms processing authorization only; omitting `--rights` records unknown publishing rights. The smoke check uses real local Whisper/Ollama and FFmpeg and fails without inventing a draft if no coherent highlight qualifies. Automated tests use explicit model doubles and generated owned media, including a real captioned 1080×1920 export with AAC synchronization checks. Whisper's child PATH includes the configured FFmpeg directory without changing the parent environment.

In restricted Codex sandboxes, Node may fail to resolve parent directories or write its global npm cache. Use a workspace npm cache (`--cache .tools/npm-cache`) and Node's `--preserve-symlinks --preserve-symlinks-main` flags for CLI entry points; ordinary local installations do not usually need them.

## Repository map

`src/client/`: dashboard and styles; `src/shared/`: types/request rules; `src/server/`: API, Twitch, job storage/queue, media, models, analysis and rendering; `tests/`: automated checks; `scripts/`: generated-recording and live-engine smoke utilities. `data/`, `.env`, generated test artifacts, build output and dependencies are ignored. No cloud model API is used.
