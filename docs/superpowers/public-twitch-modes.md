# Public Twitch modes

Preserve the CUTLINE dashboard and recording pipeline. Add a top-level mode selector, with existing recording controls remaining mounted so switching modes retains review state.

## Stages

1. Public discovery: Get Videos resolves the broadcaster; Get Clips scans at most ten 100-item pages, deduplicates, filters exact `video_id`, and ranks eligible 30–60 second clips using public metadata. Report scan limits and actual counts. No audio/video analysis or downloads.
2. Viewer OAuth and live clipping: authorization-code grant with `clips:edit`, short-lived single-use browser-bound state, fixed local redirects, HTTP-only session cookie, in-memory tokens, refresh and validation. Get Users/Get Streams resolve live channels. Manually call Create Clip; persist pending/ready/failed IDs and links; confirm with Get Clips for up to 60 seconds. Never automatically retry clip creation after ambiguous failures.
3. UI: three modes using existing panels, colors and Twitch players. Public clip thumbnails, counts and previews; connect/disconnect, live checks and saved clip links. Authorized media rendering stays unchanged.
4. Verification: unit tests for pagination/ranking/limits, OAuth security/refresh, API permission errors/rate limits; integration tests for routes and persistence; browser checks; full tests, typecheck and build. Read-only real Twitch verification where credentials permit.

## Boundaries

Application credentials provide public metadata access, not broadcaster/editor authority. Viewer OAuth never enables retrospective VOD clipping or clip downloads. OAuth secrets stay on the server; sessions require reconnect after server restart. API rate-limit resets are surfaced as Retry-After with bounded cooldowns. Discovery scans public broadcaster clips without a date filter so clips made later from the VOD remain eligible; the approximately 1,000-result Twitch limit is disclosed and results are not advertised as exhaustive.
