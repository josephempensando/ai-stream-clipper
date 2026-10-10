import type { Candidate, Highlight } from '../shared/types.js';
import { OllamaRankingError, validateNaturalRankings, validateAutoRankings } from './models.js';

export function validateCachedRankings(rows: Highlight[], candidates: Candidate[], transcriptOnly = false, auto = false): Highlight[] {
  if (!Array.isArray(rows)) throw new Error('Invalid ranking cache.');
  const supplied = candidates.filter(c => rows.some(row => row?.id === c.id));
  // Unknown IDs, repeated IDs and unsupported times still fail validation.
  const result = validateNaturalRankings({ rankings: rows }, supplied, transcriptOnly || auto);
  if (auto) return validateAutoRankings({ rankings: Object.fromEntries(candidates.map(c => [c.id, result.find(h => h.id === c.id) || null])) }, candidates);
  return result;
}

export async function recoverRankings(candidates: Candidate[], images: string[], rank: (cs: Candidate[], images: string[]) => Promise<Highlight[]>, options: {
  transcriptOnly?: boolean;
  durationMode?: 'auto';
  onAccepted?: (rows: Highlight[]) => Promise<void>;
  onReviewed?: (ids: string[]) => Promise<void>;
  onProgress?: (stage: string) => Promise<void>;
  onWarning?: (warning: string) => void;
} = {}): Promise<{ highlights: Highlight[]; error: Error | null }> {
  const highlights: Highlight[] = []; let stopped: Error | null = null;
  async function visit(batch: Candidate[], frames: string[]): Promise<void> {
    if (stopped) return;
    let accepted: Highlight[] | undefined;
    for (let attempt = 0; attempt < (batch.length === 1 ? 2 : 1); attempt++) {
      if (attempt) await options.onProgress?.('Retrying one reading context');
      try {
        const rows = await rank(batch, frames);
        try { accepted = options.durationMode === 'auto' ? validateCachedRankings(rows, batch, true, true) : validateNaturalRankings({ rankings: rows }, batch, options.transcriptOnly); }
        catch (error) { throw new OllamaRankingError(error instanceof Error ? error.message : 'Invalid model ranking.', 'invalid'); }
        break;
      } catch (error) {
        if (!(error instanceof OllamaRankingError) || !error.retryable) {
          stopped = error instanceof Error ? error : new Error('Local model analysis failed.'); return;
        }
        if (batch.length > 1) {
          options.onWarning?.('An Ollama batch failed validation or exceeded capacity; retried with smaller requests.');
          await options.onProgress?.('Recovering analysis with smaller requests');
          const middle = Math.ceil(batch.length / 2);
          const frameSplit = batch.slice(0, middle).reduce((n, c) => n + c.frameTimes.length, 0);
          await visit(batch.slice(0, middle), frames.slice(0, frameSplit));
          await visit(batch.slice(middle), frames.slice(frameSplit));
          return;
        }
      }
    }
    if (accepted) {
      highlights.push(...accepted);
      // Persist each successful recovery before attempting the next context.
      await options.onAccepted?.(accepted);
      await options.onReviewed?.(batch.map(c => c.id));
    }
  }
  await visit(candidates, images);
  return { highlights, error: stopped };
}
