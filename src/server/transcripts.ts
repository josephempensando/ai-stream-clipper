import { z } from 'zod';
import type { Candidate, Segment } from '../shared/types.js';

export const TRANSCRIPT_MAX_BYTES = 2 * 1024 ** 2;
function time(value: string): number {
  const match = /^(?:(\d+):)?([0-5]?\d):([0-5]\d)(?:[.,](\d{1,3}))?$/.exec(value.trim());
  if (!match) throw new Error('Invalid transcript time. Use HH:MM:SS.mmm or MM:SS.mmm.');
  return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(`0.${match[4] || '0'}`);
}
function clean(text: string): string {
  return text.replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, entity: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[entity] || '').replace(/\s+/g, ' ').trim();
}
export function parseTranscript(name: string, content: string, duration: number): { segments: Segment[]; warnings: string[] } {
  if (Buffer.byteLength(content, 'utf8') > TRANSCRIPT_MAX_BYTES) throw new Error('Transcript exceeds the 2 MB limit.');
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('A known positive video duration is required for transcript analysis.');
  const extension = name.toLowerCase().split('.').at(-1); const warnings: string[] = []; let segments: Segment[] = [];
  const text = content.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  if (extension === 'json') {
    let raw: unknown; try { raw = JSON.parse(text); } catch { throw new Error('Transcript JSON is invalid.'); }
    const boundary = z.union([z.number().finite(), z.string().transform(time)]);
    const schema = z.array(z.object({ start: boundary, end: boundary, text: z.string().max(10_000) })).max(50_000);
    segments = schema.parse(Array.isArray(raw) ? raw : z.object({ segments: schema }).parse(raw).segments);
  } else if (extension === 'srt' || extension === 'vtt') {
    if (/X-TIMESTAMP-MAP/i.test(text)) throw new Error('Convert VTT timestamp mapping to the original video timeline before attaching it.');
    for (const block of text.trim().split(/\n[ \t]*\n/)) {
      const lines = block.split('\n');
      if (extension === 'vtt' && /^(WEBVTT|NOTE|STYLE|REGION)(?:\s|$)/.test(lines[0] || '')) continue;
      const index = lines.findIndex(line => line.includes('-->'));
      if (index < 0) throw new Error('Each subtitle cue must have start --> end timestamps.');
      const match = /^\s*(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/.exec(lines[index]!);
      if (!match) throw new Error('Invalid subtitle timing line.');
      segments.push({ start: time(match[1]!), end: time(match[2]!), text: clean(lines.slice(index + 1).join(' ')) });
    }
  } else if (extension === 'txt') {
    const points: { start: number; text: string }[] = [];
    for (const line of text.split('\n').filter(l => l.trim())) {
      const range = /^\s*\[?([\d:.,]+)\]?\s*(?:-->|-)\s*\[?([\d:.,]+)\]?\s*(.*)$/.exec(line);
      if (range) { segments.push({ start: time(range[1]!), end: time(range[2]!), text: clean(range[3]!) }); continue; }
      const point = /^\s*\[?([\d:.,]+)\]?\s*(.*)$/.exec(line);
      if (!point) throw new Error('TXT transcripts need timestamp ranges or a timestamp on every line.');
      points.push({ start: time(point[1]!), text: clean(point[2]!) });
    }
    if (points.length && segments.length) throw new Error('Use one consistent timestamp format per TXT file.');
    for (let i = 0; i + 1 < points.length; i++) segments.push({ start: points[i]!.start, end: points[i + 1]!.start, text: points[i]!.text });
    if (points.at(-1)?.text) warnings.push('The final point-stamped line has no end boundary and was excluded. Add a final timestamp or an explicit end time.');
  } else throw new Error('Attach an SRT, VTT, JSON or timestamped TXT transcript.');
  if (segments.length > 50_000) throw new Error('Transcript exceeds 50,000 cues.');
  for (const segment of segments) {
    if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.start < 0 || segment.end <= segment.start || segment.end > duration) throw new Error('Transcript timestamps must be positive intervals within the original video duration. No timestamps were adjusted.');
    segment.text = clean(segment.text);
  }
  segments = segments.filter(s => s.text).sort((a, b) => a.start - b.start || a.end - b.end);
  if (!segments.length) throw new Error('Transcript has no usable timestamped text.');
  return { segments, warnings };
}
export function transcriptSupports(segments: Segment[], start: number, end: number, duration: number): boolean {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > duration || end <= start) return false;
  if (!segments.some(s => s.start === start && s.text.trim()) || !segments.some(s => s.end === end && s.text.trim())) return false;
  let cursor = start; let supported = false;
  for (const cue of segments) {
    if (cue.end <= start || cue.start >= end || !cue.text.trim()) continue;
    if (!supported && cue.start > start + 0.001) return false;
    if (cue.start - cursor > 8) return false;
    cursor = Math.max(cursor, cue.end); supported = true;
  }
  return supported && cursor >= end - 0.001;
}
export function transcriptCandidates(segments: Segment[], duration: number): Candidate[] {
  const candidates: Candidate[] = [];
  // These are overlapping reading contexts, not proposed clip durations.
  // Bound inference work; Ollama chooses a natural interval within each context.
  const stride = Math.max(1, Math.ceil(segments.length / 200));
  for (let i = 0; i < segments.length; i += stride) {
    const start = segments[i]!.start; const cues: Segment[] = []; let end = start; let characters = 0;
    for (let j = i; j < segments.length; j++) {
      const cue = segments[j]!;
      if (cues.length && (cue.start - end > 8 || cue.end - start > 180 || characters + cue.text.length > 6000)) break;
      cues.push(cue); end = Math.max(end, cue.end); characters += cue.text.length;
    }
    if (!transcriptSupports(cues, start, end, duration)) continue;
    candidates.push({ id: `transcript-context-${i}`, start, end, heuristicScore: 0, evidence: ['User-supplied timestamped transcript; no audio or visual analysis.'], transcript: cues.map(s => s.text).join(' '), frameTimes: [], cues });
  }
  if (candidates.length <= 120) return candidates;
  // Uniform timeline sampling avoids spending the entire budget near the opening.
  return Array.from({ length: 120 }, (_, i) => candidates[Math.floor(i * candidates.length / 120)]!);
}
