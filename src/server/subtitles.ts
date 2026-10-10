import type { Segment } from '../shared/types.js';
function timestamp(time: number): string {
  const ms = Math.max(0, Math.round(time * 1000));
  const hours = Math.floor(ms / 3_600_000); const minutes = Math.floor(ms / 60_000) % 60; const seconds = Math.floor(ms / 1000) % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}
export function createSrt(segments: Segment[], start: number, end: number): string {
  return segments.filter(s => s.end > start && s.start < end).map((s, i) => `${i + 1}\n${timestamp(Math.max(s.start, start) - start)} --> ${timestamp(Math.min(s.end, end) - start)}\n${s.text.replace(/[\r\n<>]/g, ' ').trim()}\n`).join('\n');
}
