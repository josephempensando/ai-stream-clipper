# Narrative duration policy

Cutline uses `CLIP_MIN_DURATION=30`, `CLIP_DURATION_MODE=auto` and `CLIP_COUNT=5`. Counts from 1–8 remain configurable. Legacy `DURATION_MODE` and `HIGHLIGHT_COUNT` are fallback aliases; the `CLIP_` keys take precedence. Other minimum values and non-auto modes fail configuration validation. No fixed analysis maximum is applied, including when old maximum-duration environment keys exist.

Whisper supplies segment and word timestamps. Ollama selects real cue boundaries that preserve the complete hook, setup, escalation, payoff, sentence, reaction and story. For a moment shorter than 30 seconds, surrounding context must add narrative value. Otherwise the model returns no highlight. Backend validation also excludes shorter suggestions without expanding them. Returning fewer than the requested number, including zero, is valid. Narrative quality remains an AI judgment and needs human preview.

The React editor displays each original AI-selected duration and the current adjusted duration. Both timing editors show the minimum and block export of shorter intervals. Manual edits must remain in bounds and non-overlapping. Regenerate rechecks narrative and caption boundaries without replacing the original AI duration. Completed Whisper transcription and media evidence are reused; ranking caches use a new policy version. Saved selections under 30 seconds are excluded when loading projects with a request to analyze again. Historical rendered files remain available.

Retention edits must also produce at least 30 seconds. If approved pause removal would make the result shorter, analysis retains the full selected story for review and shows a warning. The creator must disable pause shortening or revise meaningful source context before export; no padding, slow motion or filler is inserted. Dynamic captions, pattern interrupts, sound design, narrative/quality assessment, provenance and copyright review continue through the existing workflow.

## Destination checks at export

Analysis never receives a destination limit. Leave both destination fields empty for an unrestricted private MP4 draft. For a platform-specific draft, enter the platform name and its current duration limit for the intended account and upload method. These restrictions can vary, so the app does not guess a universal platform maximum.

```json
{
  "clips": [{ "id": "story", "start": 0, "end": 205 }],
  "options": {
    "layout": "blur", "cropX": 0.5, "subtitles": false,
    "destination": { "name": "My destination", "maxDurationSeconds": 180 }
  }
}
```

`POST /api/jobs/:id/render` returns HTTP 409 with `code: "DURATION_REVIEW_REQUIRED"` if the final edited duration exceeds the supplied limit or retention shortening drops below 30 seconds. No render is scheduled and no boundaries are changed. Review the story and destination, then revise the edit or explicitly clear the destination fields to create an unrestricted draft. Destination settings and original/adjusted timing metadata are recorded in `results.json`. A destination limit below 30 seconds is incompatible with this policy and rejected.

Existing public Twitch clip discovery reports source clip durations faithfully, including shorter historical clips. It is metadata discovery, not AI selection or rendering; those existing artifacts are never padded. Twitch's official clip creation retains its separate platform validation.

## Verification

Run `rtk proxy npm test`, `rtk proxy npm run build`, `rtk proxy npm run test:ui` and `rtk proxy npm run test:platform-ui`. Browser checks start isolated local servers, use mocked platform APIs, and verify recording review/export plus the existing Twitch and timestamp workflows. Duration regression cases cover fractional minimum boundaries, meaningful context, long stories, rejected candidates, cache migration, pause shortening and destination review conflicts. Media tests use generated owned recordings with explicit model doubles and validate actual H.264/AAC outputs; they do not claim live Whisper/Ollama inference.
