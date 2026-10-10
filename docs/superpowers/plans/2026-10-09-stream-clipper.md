# AI Stream Clipper Implementation Plan

**Goal:** deliver the supplied four phases as a local MVP.
**Architecture:** loopback Node API, persistent queue/cache, React review, subprocess media and local model adapters.
**Tech Stack:** TypeScript, React, Vite, Express, Zod, FFmpeg/ffprobe, Whisper CLI, Ollama.
**Spec:** ../specs/2026-10-09-stream-clipper-design.md

## Constraints

30–60 seconds; up to five non-overlapping clips; H.264/AAC 1080x1920; server-only OAuth; permission confirmation; no scraping. Preserve AGENTS.md. Supplied directory has no Git repository.

## Tasks

- [x] Phase 1: types, parser/security tests, metadata and upload API, dependency health, dashboard.
  Files: src/shared/*, src/server/{config,security,twitch,app,store}.ts, src/client/*, build configs.
  Tests: malformed URL, foreign/private hosts, upload permission, actual MP4 validation.
- [x] Phase 2: media adapter/semaphore, chunked cached Whisper with offsets, audio/scene evidence, candidates, Ollama structured ranking, queue.
  Files: src/server/{process,media,analysis,pipeline,jobs}.ts.
  Tests: chunk offsets, concurrency, window bounds/overlap, invalid rankings, engine failures.
- [x] Phase 3: review edits, crop/blur rendering, SRT, download/ZIP and manifest.
  Files: src/server/{render,subtitles}.ts, src/client/App.tsx.
  Tests: invalid edits, subtitle rebasing, ffprobe dimensions/duration/audio, artifact routes, ZIP.
- [x] Phase 4: authorized Twitch create/download, validated identity/scopes, manual UI.
  Tests: wrong client/scope, vod_offset=end, pending downloads, API denials.
- [x] Windows README, .env.example, generated recording, live-engine smoke command; tests/typecheck/build/final review. Actual live-engine execution remains unavailable without installed Whisper/Ollama.

## Review Focus

DNS rebinding/redirects; invalid uploads/limits; incomplete model rankings; long-stream offsets/restart recovery; edited ranges and subtitle/audio sync.

## Execution Record

User supplied requirements, phases and explicit implementation authorization; proceed inline under session instructions without additional skill approval gates. No Git worktree is available. Initially absent tools: FFmpeg, ffprobe, Whisper, Ollama. Model doubles are test-only and must be disclosed in results.

Final: npm test passed 26/26; npm run typecheck and npm run build passed; desktop/mobile browser checks passed. Actual FFmpeg/ffprobe exercised five exports, audio/video timing, crop, subtitles and ZIP with test-only model doubles. Independent review findings (admission races, RMS sample rate, unbounded rejected download bodies) were reproduced/fixed and regression tested. Actual Get Videos lookup for URL ID succeeded; no VOD media was acquired or processed. See ../../validation.md.
