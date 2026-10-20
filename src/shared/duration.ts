export const CLIP_MIN_DURATION = 30;
export const DEFAULT_CLIP_COUNT = 5;
// Timestamp subtraction can turn an exact decimal 30s into 29.999999999999996.
const timestampEpsilon = 1e-9;
export function meetsMinimumDuration(duration: number, minimum = CLIP_MIN_DURATION): boolean {
  return Number.isFinite(duration) && duration >= minimum - timestampEpsilon;
}

// Limits depend on destination, account and upload method. The creator supplies
// the applicable platform limit at export; analysis never consumes it.
export interface ExportDestination { name: string; maxDurationSeconds: number }
export class DurationReviewError extends Error {
  readonly code = 'DURATION_REVIEW_REQUIRED';
}
export function validateExportDurations(clips: { id: string; duration: number }[], destination?: ExportDestination): void {
  for (const clip of clips) {
    if (!meetsMinimumDuration(clip.duration)) throw new DurationReviewError(`Clip ${clip.id} is below the ${CLIP_MIN_DURATION}-second minimum after editing. Review the boundaries or disable pause shortening; filler will not be added.`);
    if (destination && clip.duration > destination.maxDurationSeconds + timestampEpsilon) throw new DurationReviewError(`Clip ${clip.id} lasts ${clip.duration.toFixed(2)}s and exceeds ${destination.name}'s ${destination.maxDurationSeconds}s limit. Review the complete story and destination before export. No clip has been trimmed.`);
  }
}
