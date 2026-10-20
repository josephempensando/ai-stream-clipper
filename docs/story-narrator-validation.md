# Story Narrator validation

Implemented in the existing Cutline application on `codex/story-narrator`, preserving the earlier uncommitted 30-second clip-duration work. No rebuild, platform publishing, cloud TTS or voice cloning was introduced.

## Local engines and real samples

Verified Python **3.11.9**, **piper-tts 1.8.0**, **openai-whisper 20250625**, Whisper **base**, stock **en_US-lessac-medium**, and the existing FFmpeg/ffprobe binaries. `pip check` reported no broken requirements. The Lessac ONNX/config files and permitted registry are installed under ignored `data/piper-voices` in this workspace. Other machines require the exact README installation steps.

| Real case | Narration | MP4 | Alignment | Evidence |
| --- | --- | --- | --- | --- |
| Short original story, five-second background | 10.39875 s | 10.400 s | Every original token, coverage 1.0 | `test-artifacts/story-smoke-2026-10-19T07-38-33-259Z/validation.json` |
| Long original story, sentence paragraphs, 0.85× voice | 96.240021 s | 96.267 s | Every original token, coverage 1.0 | `test-artifacts/story-smoke-2026-10-19T07-24-41-555Z/validation.json` |
| Long output rendered again after review fixes | Same actual narration/timestamps | 96.267 s | Preserved verified alignment | `test-artifacts/story-final-long/validation.json` |

The final short smoke used **actual HTTP endpoints**: asynchronous voice-preview creation/status/WAV (1.962086 seconds), multipart story creation, job polling, ranged MP4 playback (206), and attachment download (200, exact output byte count). Its results manifest records effective Python/Piper/Whisper versions, voice/model/settings, original text, timestamps, codecs, durations and warnings. The long run exercised real Piper/Whisper and the job pipeline; its final rerender reused that real narration and alignment, exercising the updated seamless-loop renderer and final codec/synchronization validation without repeating model inference.

The supplied MP4 (`assets/story/sample.mp4`) is an original five-second grid animation generated with FFmpeg. Both prose samples are original fixtures. This footage contains no third-party video or music. Background/music audio tests use generated tones; those tests are not claimed as real speech synthesis.

Earlier long prose attempts produced Whisper substitutions and zero-duration hallucinated retry words. They correctly stopped with `CAPTION_ALIGNMENT_REVIEW_REQUIRED`. Matching was not relaxed: the sample prose was revised for clear ordinary vocabulary and sentence-sized paragraphs. Arbitrary scripts can still require pronunciation review, retry, or captions disabled. The application never rewrites a user's submitted script to make recognition pass.

Representative long-output frames (`test-artifacts/story-final-long/middle.jpg` and `ending.jpg`) and the mobile Story Narrator screenshot were inspected. Captions are visible in the safe lower area; the ending frame retains the final thought. Automated tests verify the final audible tone marker survives encoding. No human listening session was available in the tool environment; alignment/encoding success is not a subjective pronunciation or sound-quality assessment.

## Automated and browser coverage

Final results: **170/170 automated tests pass**, with zero failures/skips. TypeScript and production build pass. `test:story-ui`, `test:ui` and `test:platform-ui` pass on the final build; `git diff --check` is clean. Full output is retained in `test-artifacts/story-final-tests.log`.

The suite covers exact text/Unicode/chunk spans, overlong tokens, inverse Piper speed, real child-process WAV validation, missing/empty/corrupt/nonzero TTS output, process-tree cancellation, queue removal, shutdown/admission races, retained-file rollback, previous successful drafts, real resolved file containment, interrupted recovery, permissions, private API responses, JSON/music limits, disconnected multipart cleanup, repeated-word/number/contraction alignment and selected-voice language with measured offsets. Real FFmpeg checks cover sub-30-second output, looping, audio/video codecs and synchronization, final speech marker, music seam continuity, original audio plus music ducking, progress-persistence failure, and interrupted encoding.

Browser checks cover Story Narrator navigation, exact script submission, stats/settings/permission gates, stale preview suppression/deletion, playable returned WAV metadata, restored voice selection surviving late readiness, generated-output actions, and desktop/mobile layout. Browser API fixtures are controlled; the separate HTTP smoke uses real engines. Existing dashboard, timestamp-analyzer and public/live Twitch browser checks pass without platform posting.

The optional retention browser check was attempted against the older local spoken fixture. That fixture's selected highlight is only **4.04 seconds**, so the new clipping minimum correctly excludes it and the check stops at its valid-completed-fixture precondition. Existing retention unit/API/render tests still run in the full suite; no valid 30-second live retention browser fixture was available. This is a browser-fixture limitation, not a Story Narrator engine setup requirement.

## Independent review

One fresh read-only whole-feature review identified lifecycle and safety defects. Regression tests and fixes cover progress rejection handling, preview admission during shutdown, selected voice language, cancellable probes, coordinated owned-process shutdown, per-job/per-attempt containment, late readiness overwriting a restored voice, and post-upload validation/admission cancellation. Additional fixes cover preview excerpt word boundaries, private JSON error handling, successful work cleanup retry, and effective engine metadata.

Deferred minor: successful draft duration is displayed after promotion; active attempts show real stage/chunk/encoded-time progress and an estimated duration. Earlier successful draft duration remains associated with its available preview during regeneration.

## Rulings I made

- Work in the requested dirty workspace on a dedicated branch with a baseline snapshot: keeps prior duration work available; cost if wrong is mixed uncommitted changes requiring careful staging.
- Use Windows-native ledger/brief helpers instead of Bash-only skill scripts: compatible with this PowerShell environment; cost if wrong is manual bookkeeping rather than helper-generated checkpoints.
- Leave task changes uncommitted: avoids accidentally committing prior user changes; cost if wrong is that the user must stage/commit the reviewed feature later.
- Use HTTP 422 for caption content requiring review, with 409 for unavailable artifacts: distinguishes alignment from state errors; cost if wrong is that API clients must support the documented 422 code.

No external messages, deployment, push, merge or publishing actions were taken. Development/test servers launched for verification were closed.

## Caption alignment follow-up

A real saved job failed on its first narration chunk: ordinary clock formatting was returned as a compact/split AM token, and a proper name was misspelled by recognition. The full-script initial prompt then produced hallucinated continuation text and zero-duration words. The repair supports equivalent compact/split AM/PM clock formatting, additional ordinary contractions, and a single retry using source-derived name hints with deterministic independent Whisper windows. Original caption text and actual word timestamps remain unchanged; different clock values, missing words and unsupported substitutions still fail review. Errors now identify the chunk and nearby unmatched source word.

The reproduced first chunk passes with coverage 1.0 and zero zero-duration words using real Piper/Whisper audio. Regression tests cover the formatting variants, exact name-hint/decoding arguments and mismatch rejection. Full automated suite: **172/172 pass**; TypeScript and production build pass. Evidence is retained privately under `test-artifacts/story-alignment-debug-*` and `test-artifacts/story-alignment-fix-tests.log`.

A subsequent full retry exposed another ordinary ASR omission, confirming that transcript equality alone cannot reliably align known narration. A Whisper cross-attention/DTW refinement now aligns the exact supplied TTS text to actual audio in anchored short windows, requiring anchor support, confidence, speech energy and positive monotonic times. The production helper passed the failing 44.962-second audio with **141 actual model-derived word spans**, complete caption coverage and preserved original text. No guessed spacing or ASR-derived replacement text was introduced. Helper output with missing words or low confidence is rejected. The Python asset is copied into the production build.

An independent read-only review found no Critical/Important defects. Deferred minors: forced-aligner failure diagnostics currently fall back to the safe review error, and a deterministic retry can repeat without new vocabulary hints. Very short scripts with insufficient anchors can still legitimately require review.

The second real narration chunk exposed a distinction between token likelihood and alignment evidence: uppercase `DO` had likelihood 0.0032, while independent ASR recognized `do` at 25.42–25.64 seconds and DTW placed it at 25.41–25.65 seconds. A low-likelihood word is now accepted only when the same normalized word has independently recognized timing overlapping at least half its DTW span. Positive monotonic times and actual speech energy remain required. Pure Python regression checks reject mismatched words, unrelated timestamps, marginal overlap and empty spans; the child-process boundary also rejects unsupported low likelihood.

Final saved-audio verification (2026-10-20): uppercase emphasis is normalized only for model conditioning, with original display text restored by script validation. A zero-duration DTW article can use an exact independently recognized positive span only within 80 ms and neighboring word boundaries; ambiguous, distant or overlapping candidates are rejected. Punctuation-only model tokens do not create spoken spans. All **eight captured chunks pass real Whisper alignment**, and regenerated ASS/SRT files preserve **972 original word spans**, coverage 1.0 and 343.231646 seconds of measured chunk audio. Evidence: ignored `test-artifacts/story-user-captured/validation-results.json` and `caption-verification.json`.

The saved job now has a newer successful draft with **subtitles disabled**. That existing output was preserved, not regenerated or relabeled as captioned. Its preview/download endpoints both return HTTP 200; independent ffprobe confirms H.264 at 1080×1920, AAC at 48 kHz, video 344.300 seconds and audio 344.288 seconds. No subtitle artifact was attached to that draft.

Verification: full Node suite **174/174 pass** before the final Python-only refinements; afterward all **7 focused Node regressions**, **3 pure Python checks**, real eight-chunk alignment, TypeScript/production build and `git diff --check` pass. The built server includes the updated Python helper. No additional dependencies or voice models are needed beyond the documented local setup.

## Voice presets (2026-10-20)

Added Woman (existing Lessac ID), Man (Ryan medium), and Childlike (Lessac with +3 semitones and tempo compensation). Registry setup adds missing presets, preserves custom entries/settings and remains idempotent. Ryan's local model/config are installed alongside Lessac; all three actual API previews return playable WAV audio. No existing story was regenerated.

The childlike preset is explicitly labeled as a synthetic stock-voice style. Its processing is shared by previews and complete narration, with measured durations and caption alignment performed after the pitch change. A real-FFmpeg regression verifies a 440 Hz tone shifts to approximately 523 Hz while retaining duration. New setup regression checks custom-entry preservation and repeated setup.

Full suite: **176/176 tests pass**, zero failures/skips. TypeScript, production build, Story Narrator browser checks (all three choices selectable), and whitespace checks pass. Real childlike smoke output is a captioned **10.21025-second** narration with coverage **1.0**, 1080×1920 H.264/AAC video, looping background, HTTP 206 preview and HTTP 200 download. Evidence: `test-artifacts/story-voice-previews.json` and `test-artifacts/story-smoke-2026-10-19T23-51-28-147Z/validation.json`. The existing successful saved video remains available.
