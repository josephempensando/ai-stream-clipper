# Copyright-aware editor: Phase 1

User request: implement Phase 1 first in the existing React/TypeScript/Node app, preserving metadata/URL support, local inference, and draft exports. Phases 2–4 remain separate follow-up work.

## Design

- Persist source rights independently of processing consent. Record creator, source URL, category, evidence, license/conditions, platforms, uses, and expiration. Missing/legacy records are unknown, never inferred from a file or an old checkbox.
- Present own, licensed, public-domain, six CC 4.0 licenses, unknown, prohibited, and claimed-exception categories. Derive CC BY/NC/ND/SA requirements from the selected license; preserve license evidence and additional conditions. Exceptions always require human review. Assessment is record completeness/restrictions, never legal clearance. Phase 1 does not authorize automated publishing.
- Allow private analysis and existing draft exports for any recorded publishing-rights status. Preserve explicit processing consent and approved-host import security.
- Add a short-form analysis policy (default for new uploads): Ollama selects supported cue boundaries spanning 30–60 seconds, or returns null if no coherent highlight qualifies. Validate durations, source bounds, cue support, IDs, and at most five non-overlapping final results. Keep the previous natural-duration policy for existing projects and explicit selection.
- Reuse transcription/evidence caches. Separate ranking caches by policy and retain completed no-highlight decisions as well as accepted highlights. Keep partial-failure recovery.
- Add a rights form and assessment in the recording workbench using existing panels. Show readable timestamps, transcript excerpts, selection reasons, and both AI and heuristic scores. Mark exports as drafts and keep rights warnings visible.

## Implementation order

1. Add failing API and model tests covering missing rights, expiration, platform restrictions, CC conditions, private analysis, and invalid timestamp/duration output.
2. Implement shared rights schema/assessment, upload persistence, editable rights endpoints, legacy handling, and draft metadata.
3. Implement short-form model policy, nullable decisions, recovery/cache support, and selection validation without altering URL metadata analysis.
4. Integrate the rights form and policy selection into the existing UI; add browser checks including mobile and missing-rights analysis.
5. Verify TypeScript, full tests including real FFmpeg exports, and an authorized generated speech MP4 using local Whisper/Ollama. Clearly distinguish test doubles from real model checks.

## Remaining phases

Phase 2: audio leveling, sentence-aware boundary assistance, export preview/regeneration improvements and platform draft workflow.
Phase 3: grounded editable commentary, microphone recording, source/commentary separation and licensed-asset assembly.
Phase 4: platform presets/metadata, six human review checks, automated-publishing guard and standalone provenance report.

## Review focus

Expired permissions, restricted platforms, incomplete/legacy records, NC commercial use, ND adaptations, exception review, forged model timestamps, null decisions, cache isolation, unchanged source timing/audio sync, and preservation of platform metadata workflows.
