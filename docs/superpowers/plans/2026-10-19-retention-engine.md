# AI Retention Editing Engine

Extend the existing authorized-recording workflow, preserving all existing routes and tabs. The checkout contains no Story Narrator implementation. Existing `.env.example` edits belong to the user and must be preserved.

1. Add optional, backward-compatible retention settings and word-level transcript data. Keep Whisper's actual word timestamps through chunk offsets; never interpolate word alignment.
2. Add an Ollama narrative pass over selected highlights. The model references numbered source cues for hook, setup, escalation, payoff and ending. Validate every reference; derive displayed quotes and timestamps from the transcript. Incomplete narratives rank below complete narratives. Keep model judgments labeled as judgments.
3. Build a source-time EDL with exact reasons and chronological keep spans. Only remove model-approved inter-cue silence, preserving speech and pause handles. Use measured scene/energy evidence for restrained optional punch-ins. No generated B-roll, invented reactions or chronological reordering.
4. Render the EDL with FFmpeg: synchronized trim/concat, 1080x1920 H.264/AAC, 30/60 FPS, safe crop/blur, ASS karaoke captions from real word timestamps, dialogue normalization, optional owned/licensed audio uploads with provenance, ducking, and one optional CTA. A loop is permitted only after a positive narrative assessment.
5. Add a React retention panel to the existing authorized video editor. Include settings, per-clip narrative/EDL review, boundary and caption corrections, visual/ending overrides, regenerate/export, source and rendered previews, genuine queue progress/errors.
6. Verify narrative rejection, natural durations, alignment, configuration, API validation, existing workflows and real FFmpeg outputs using generated owned sample footage. Report local-model availability separately from tests with doubles.

Tests first for analysis/EDL and render behavior. Reuse installed dependencies; do not add model downloads or unrelated changes. Publishing remains governed by existing rights assessments and approvals. No automatic publishing.
