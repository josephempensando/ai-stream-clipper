import type { Segment } from '../shared/types.js';
function timestamp(time: number): string {
  const ms = Math.max(0, Math.round(time * 1000));
  const hours = Math.floor(ms / 3_600_000); const minutes = Math.floor(ms / 60_000) % 60; const seconds = Math.floor(ms / 1000) % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}
export function createSrt(segments: Segment[], start: number, end: number): string {
  const cues: Segment[] = [];
  for (const segment of segments) {
    if (segment.end <= start || segment.start >= end || segment.end <= segment.start) continue;
    // Whisper supplies segment timestamps, so shorter captions use proportional
    // timing within the original segment, before trimming to the selected clip.
    const text = segment.text.replace(/[\r\n<>{}\\]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const lines: string[] = [];
    let line = '';
    for (const token of text.split(' ').flatMap(word => word.match(/.{1,32}/gu) || [])) {
      if (line && line.length + token.length + 1 > 32) { lines.push(line); line = ''; }
      line = line ? `${line} ${token}` : token;
    }
    if (line) lines.push(line);
    const captions: string[] = [];
    for (let i = 0; i < lines.length; i += 2) captions.push(lines.slice(i, i + 2).join('\n'));
    const weights = captions.map(caption => caption.replace(/\s/g, '').length);
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let consumed = 0;
    for (const [i, caption] of captions.entries()) {
      const cueStart = segment.start + (segment.end - segment.start) * consumed / total;
      consumed += weights[i]!;
      const cueEnd = segment.start + (segment.end - segment.start) * consumed / total;
      if (cueEnd > start && cueStart < end) cues.push({ start: Math.max(cueStart, start) - start, end: Math.min(cueEnd, end) - start, text: caption });
    }
  }
  return cues.map((cue, i) => `${i + 1}\n${timestamp(cue.start)} --> ${timestamp(cue.end)}\n${cue.text}\n`).join('\n');
}
