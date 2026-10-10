# Livestream Highlight Analyzer Implementation Plan

**Goal:** Paste a Twitch/YouTube stream URL and review up to five evidence-supported timestamps for manual clipping, without acquiring or exporting platform video.

**Architecture:** Add an isolated timestamp-analysis service and primary dashboard panel. Preserve the recording pipeline, existing clip discovery/live controls, design and embedded players. Resolve only official platform metadata; rank exact Twitch clip intervals or transcript-supported windows through local Ollama.

**Tech stack:** Existing TypeScript/Node/Express/React/Vite, Twitch Helix, YouTube Data API, local Ollama (`llama3.2`). No new dependencies.

## Constraints

- Preserve existing AGENTS.md and server-side credentials/SSRF protections.
- Twitch `Get Clips.vod_offset` is the start offset; never confuse it with the end-offset parameter of Create Clip From VOD.
- Prefer 30–60s Twitch clips; use shorter clips only as actual-length supplemental results, never pad content. Drop missing offsets/IDs and out-of-VOD intervals. Select non-overlapping intervals.
- YouTube metadata uses a server API key. Accept legitimately supplied SRT/VTT/JSON/TXT timestamps. No caption scraping or platform-media downloader.
- Transcript windows must be 30–60s, supported by supplied cue intervals and known video duration, non-overlapping, with model output constrained to known IDs.
- Unknown live duration, absent/insufficient transcript or absent qualifying clips returns an explicit unavailable/partial result.
- Scores are uncalibrated rankings; timing evidence and content confidence are labeled separately.
- JSON/CSV exports contain analysis only. Existing local MP4 export stays in the authorized-recording workflow and requires explicit actions.

## Implementation stages

1. Add failing tests for platform URL parsing, transcript parsing/coverage, Twitch offsets/short clips/non-overlap/date pagination and analysis export escaping.
2. Implement official metadata clients, bounded date-filtered Twitch search and timestamp-only analysis service with bounded transcript ranking/cache. Add API integration tests, unavailable states and model-failure coverage.
3. Add primary Source URL/Analyze Highlights panel, transcript attachment, result cards, original-player preview, seek links/copy controls and JSON/CSV exports; preserve old controls in their modes.
4. Run existing and new tests, TypeScript/build, browser checks and independent review; verify real read-only Twitch results where credentials permit. Document API keys, transcript formats, run commands and verified limitations.

## Review focus

Schedule query IDs conflicting with URL paths; missing/zero/fractional offsets; popular overlapping clips hiding distinct intervals; late-created clips outside a broadcast-date search; transcript gaps or mismatched video timelines; malicious model IDs/times, spreadsheet formula injection, API quota errors and unknown live durations.
