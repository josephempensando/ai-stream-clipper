# AI Stream Clipper MVP

Local single-user React/Vite dashboard and Node/TypeScript API for authorized recordings. Default target: URL ID 2895693134; supplied alternative 289563134 is distinct. Never scrape Twitch media.

## Architecture

Loopback API, same-origin Vite proxy, persistent jobs and content-addressed caches in ignored data/. One analysis job at a time, globally bounded FFmpeg subprocesses, interrupted-job recovery on restart.

Multipart MP4 upload requires permission confirmation and recording-to-VOD timestamp offset. Approved HTTPS sources require exact operator allowlisting, public DNS pinned to the connection, bounded size/time and no redirects. FFmpeg receives local files only.

Probe recordings; extract ten-minute mono WAV chunks; local Whisper JSON with absolute offsets; per-second loudness and scene changes; contextual 30–60-second candidate windows and sampled JPEGs. Structured Ollama ranking judges humor, surprise and narrative. Optional vision model receives frames. Signals are heuristic, not a reliable laughter classifier or quality guarantee. Return up to five non-overlapping highlights, explicitly explaining shortages.

Review includes preview, editable timestamps, selection, blurred padding or configurable crop, and synchronized subtitles. Render sequential 1080x1920 H.264/AAC MP4s, clip-01.mp4…clip-05.mp4, results.json and ZIP with provenance.

Twitch Get Videos uses server-only OAuth. Broadcaster/editor tokens are validated for client, identity, and channel:manage:clips or editor:manage:clips. Create Clip From VOD uses end time for vod_offset. Poll official download URLs; manual clip creation does not grant full-VOD analysis access.

## Validation

Tests: parsers, SSRF, timestamp/overlap boundaries, subtitles, queue limits, OAuth contracts, HTTP upload/jobs/artifacts. Generated owned media exercises actual FFmpeg/ffprobe with clearly labeled test-only model doubles. Separate live-engine smoke requires actual Whisper/Ollama. Never claim target VOD analysis without processing its acquired video.
