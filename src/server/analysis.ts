import type { Candidate, Evidence, Highlight, Segment } from '../shared/types.js';
export function offsetSegments(segments: Segment[], offset: number, duration: number): Segment[] {
  return segments.map(s => ({ start: Math.max(0, s.start + offset), end: Math.min(duration, s.end + offset), text: s.text.trim() }))
    .filter(s => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start && s.text.length > 0);
}
const reaction = /\b(wow|what|no way|oh my|insane|wait|crazy|unbelievable|haha|laugh|clutch|let'?s go)\b|[!?]{2}/i;
export function buildCandidates(segments: Segment[], evidence: Evidence[], duration: number): Candidate[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const cues = segments.filter(s => Number.isFinite(s.start) && Number.isFinite(s.end) && s.start >= 0 && s.end <= duration && s.end > s.start && s.text.trim()).sort((a, b) => a.start - b.start);
  if (!cues.length && !evidence.length) return [];
  const baseline = evidence.length ? evidence.reduce((n, e) => n + e.loudness, 0) / evidence.length : -40;
  const contexts: Candidate[] = [];
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
  // Bound text per inference, not clip duration. Overlapping reading contexts
  // preserve complete cues and spread attention across the whole recording.
  const starts = cues.length <= 120 ? cues.map((_, i) => i) : Array.from({ length: 120 }, (_, i) => Math.floor(i * (cues.length - 1) / 119));
  for (const index of starts) {
    const speech: Segment[] = []; let characters = 0;
    for (const cue of cues.slice(index)) {
      if (speech.length && characters + cue.text.length > 6000) break;
      speech.push(cue); characters += cue.text.length;
    }
    const start = speech.length ? Math.max(0, speech[0]!.start - 8) : 0;
    const end = speech.length ? Math.min(duration, Math.max(...speech.map(s => s.end)) + 8) : duration;
    contexts.push(makeContext(`recording-context-${index}`, start, end, speech));
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
  const eventContexts: Candidate[] = [];
  for (const [key, gap] of gaps) {
    const frames = gap.events.length <= 3 ? gap.events : [gap.events[0]!, gap.events[Math.floor(gap.events.length / 2)]!, gap.events.at(-1)!];
    eventContexts.push(makeContext(`recording-events-${key}`, gap.start, gap.end, [], frames));
  }
  const evenly = (rows: Candidate[], count: number) => rows.length <= count ? rows : Array.from({ length: count }, (_, i) => rows[Math.floor(i * (rows.length - 1) / Math.max(1, count - 1))]!);
  const events = evenly(eventContexts, Math.min(30, 120 - Math.min(contexts.length, 90)));
  return [...evenly(contexts, 120 - events.length), ...events];
}
export function selectBestHighlights(highlights: Highlight[], count = 5): Highlight[] {
  const selected: Highlight[] = [];
  for (const highlight of [...highlights].sort((a, b) => b.score - a.score)) {
    if (selected.length >= count) break;
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
