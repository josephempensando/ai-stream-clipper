import type { Candidate, Evidence, Highlight, Segment } from '../shared/types.js';
import { MAX_HIGHLIGHT_COUNT } from '../shared/validation.js';
export function offsetSegments(segments: Segment[], offset: number, duration: number): Segment[] {
  return segments.map(s => ({ start: Math.max(0, s.start + offset), end: Math.min(duration, s.end + offset), text: s.text.trim() }))
    .filter(s => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start && s.text.length > 0);
}
const reaction = /\b(wow|what|no way|oh my|insane|wait|crazy|unbelievable|haha|laugh|clutch|let'?s go)\b|[!?]{2}/i;
export interface CandidateContext {
  id: string;
  start: number;
  end: number;
  cueCount: number;
  priority?: number;
  materialize: () => Candidate;
}
export function cuePriority(cues: Segment[], index: number): number {
  // Cheap hints for shortlisting; final boundaries and quality remain model judgments.
  return cues.slice(index, index + 6).filter(cue => reaction.test(cue.text)).length * 10;
}
export function shortlistContexts(contexts: CandidateContext[], budget: number): CandidateContext[] {
  const limit = Math.max(1, Math.floor(budget));
  if (contexts.length <= limit) return contexts;
  const ordered = [...contexts].sort((a, b) => a.start - b.start || a.end - b.end);
  if (limit === 1) return [ordered[0]!];
  const selected = [ordered[0]!];
  // Reserve both recording edges and choose one promising context per intervening region.
  for (let bucket = 0; bucket < limit - 2; bucket++) {
    const start = 1 + Math.floor(bucket * (ordered.length - 2) / (limit - 2));
    const end = 1 + Math.floor((bucket + 1) * (ordered.length - 2) / (limit - 2));
    const middle = (start + end - 1) / 2;
    let best = start;
    for (let i = start + 1; i < end; i++) {
      const score = ordered[i]!.priority ?? 0; const previous = ordered[best]!.priority ?? 0;
      if (score > previous || score === previous && Math.abs(i - middle) < Math.abs(best - middle)) best = i;
    }
    selected.push(ordered[best]!);
  }
  selected.push(ordered.at(-1)!);
  return selected;
}
export function buildCandidateContexts(segments: Segment[], evidence: Evidence[], duration: number): CandidateContext[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const cues = segments.filter(s => Number.isFinite(s.start) && Number.isFinite(s.end) && s.start >= 0 && s.end <= duration && s.end > s.start && s.text.trim()).sort((a, b) => a.start - b.start);
  if (!cues.length && !evidence.length) return [];
  const baseline = evidence.length ? evidence.reduce((n, e) => n + e.loudness, 0) / evidence.length : -40;
  const contexts: CandidateContext[] = [];
  const makeContext = (id: string, start: number, end: number, speech: Segment[], eventFrames?: number[]): Candidate => {
    const signals = evidence.filter(e => e.time >= start && e.time < end);
    const loud = signals.filter(e => e.loudness > baseline + 6).length;
    const scenes = signals.filter(e => e.scene).length;
    const reactive = speech.filter(s => reaction.test(s.text)).length;
    const heuristicScore = Math.min(100, loud * 2 + scenes * 4 + reactive * 10 + Math.min(15, speech.length));
    const clues: string[] = [];
    if (loud) clues.push(`Context: ${loud} loudness spikes relative to recording baseline`);
    if (scenes) clues.push(`Context: ${scenes} scene changes`);
    if (reactive) clues.push(`Context: ${reactive} reaction/laughter language cues (not confirmed laughter)`);
    const notable = signals.filter(e => e.scene || e.loudness > baseline + 6);
    const sampled = notable.length <= 12 ? notable : Array.from({ length: 12 }, (_, i) => notable[Math.floor(i * (notable.length - 1) / 11)]!);
    clues.push(...sampled.map(e => `At ${e.time}s: ${e.scene ? 'scene change; ' : ''}loudness ${e.loudness.toFixed(1)} dB`));
    if (!clues.length) clues.push('Context window; no strong energy signal');
    return { id, start, end, heuristicScore, evidence: clues, transcript: speech.map(s => s.text).join(' '), cues: speech, frameTimes: [...new Set(eventFrames || [start, (start + end) / 2, end - Math.min(0.1, (end - start) / 2)])] };
  };
  // Bound each inference's text, while covering every cue in the recording.
  for (let index = 0; index < cues.length; index++) {
    let characters = 0; let last = index; let latestEnd = cues[index]!.end;
    for (let j = index; j < cues.length; j++) {
      const cue = cues[j]!;
      if (j > index && characters + cue.text.length > 6000) break;
      last = j; characters += cue.text.length; latestEnd = Math.max(latestEnd, cue.end);
    }
    const start = Math.max(0, cues[index]!.start - 8);
    const end = Math.min(duration, latestEnd + 8);
    const id = `recording-context-${index}`;
    contexts.push({ id, start, end, cueCount: last - index + 1, priority: cuePriority(cues, index), materialize: () => makeContext(id, start, end, cues.slice(index, last + 1)) });
  }
  // Preserve non-speech gameplay and reactions outside transcript contexts.
  const uncovered = evidence.filter(e => e.time >= 0 && e.time < duration && (e.scene || e.loudness > baseline + 6) && !contexts.some(c => e.time >= c.start && e.time < c.end));
  const gaps = new Map<string, { start: number; end: number; events: number[] }>();
  for (const event of uncovered) {
    const before = cues.filter(s => s.end <= event.time).at(-1);
    const after = cues.find(s => s.start > event.time);
    const start = before?.end || 0; const end = after?.start ?? duration;
    const key = `${start}-${end}`;
    const gap = gaps.get(key) || { start, end, events: [] };
    gap.events.push(event.time); gaps.set(key, gap);
  }
  const eventContexts: CandidateContext[] = [];
  for (const [key, gap] of gaps) {
    const frames = gap.events.length <= 3 ? gap.events : [gap.events[0]!, gap.events[Math.floor(gap.events.length / 2)]!, gap.events.at(-1)!];
    const id = `recording-events-${key}`;
    eventContexts.push({ id, start: gap.start, end: gap.end, cueCount: 0, priority: 20, materialize: () => makeContext(id, gap.start, gap.end, [], frames) });
  }
  return [...contexts, ...eventContexts];
}
export function buildCandidates(segments: Segment[], evidence: Evidence[], duration: number): Candidate[] {
  return buildCandidateContexts(segments, evidence, duration).map(context => context.materialize());
}
export function selectBestHighlights(highlights: Highlight[], count: number | 'all' = MAX_HIGHLIGHT_COUNT, minEngagementScore = 0): Highlight[] {
  const selected: Highlight[] = [];
  const limit = count === 'all' ? MAX_HIGHLIGHT_COUNT : Math.min(MAX_HIGHLIGHT_COUNT, count);
  for (const highlight of [...highlights].sort((a, b) => b.score - a.score)) {
    if (selected.length >= limit) break;
    if (highlight.score < minEngagementScore) continue;
    if (selected.every(h => highlight.end <= h.start || highlight.start >= h.end)) selected.push(highlight);
  }
  return selected;
}
export function selectHighlights(highlights: Highlight[], count = 5): Highlight[] {
  // Cardinality-constrained weighted interval scheduling: greedy picks can block
  // two good moments with one slightly better moment and miss the requested five.
  const ordered = [...highlights].sort((a, b) => a.end - b.end);
  const dp: (Highlight[] | null)[][] = Array.from({ length: ordered.length + 1 }, () => Array.from({ length: count + 1 }, (_, k) => k === 0 ? [] : null));
  const value = (clips: Highlight[]) => clips.reduce((sum, h) => sum + h.score + h.heuristicScore / 1000, 0);
  for (let i = 1; i <= ordered.length; i++) {
    const current = ordered[i - 1]!; let previous = i - 1;
    while (previous > 0 && ordered[previous - 1]!.end > current.start) previous--;
    for (let k = 1; k <= count; k++) {
      const skip = dp[i - 1]![k] ?? null;
      const prefix = dp[previous]![k - 1]; const take = prefix ? [...prefix, current] : null;
      dp[i]![k] = take && (!skip || value(take) > value(skip)) ? take : skip;
    }
  }
  for (let k = count; k > 0; k--) {
    const result = dp[ordered.length]![k]; if (result) return result.sort((a, b) => b.score - a.score);
  }
  return [];
}
