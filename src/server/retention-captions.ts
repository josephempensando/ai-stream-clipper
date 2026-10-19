import type { Segment, Word } from '../shared/types.js';
import type { CaptionStyle, ClipRetention, RetentionEdl } from '../shared/retention.js';
import { outputTime } from './retention.js';

export function alignedWords(segments: Segment[]): Word[] {
  return segments.flatMap(s => {
    const words = s.words || [];
    let previous = s.start;
    if (words.some(w => !Number.isFinite(w.start) || !Number.isFinite(w.end) || w.start < s.start - 0.05 || w.end > s.end + 0.05 || w.end <= w.start || !w.word.trim())) return [];
    for (const word of words) { if (word.start < previous - 0.05) return []; previous = word.end; }
    return words;
  });
}
function escapeText(text: string): string { return text.replace(/[{}\\\r\n]/g, ' ').replace(/\s+/g, ' ').trim(); }
function assTime(time: number): string {
  const cs = Math.round(time * 100); return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}
function color(hex: string): string { return `&H00${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`; }
export function validateCorrections(segments: Segment[], corrections: ClipRetention['captions'], start: number, end: number): void {
  const allowed = [...alignedWords(segments).map(w => ({ start: w.start, end: w.end })), ...segments];
  const seen = new Set<string>();
  for (const correction of corrections) {
    const key = `${correction.start}/${correction.end}`;
    if (seen.has(key) || correction.start < start || correction.end > end || !allowed.some(a => a.start === correction.start && a.end === correction.end)) throw new Error('Caption corrections must use unique original word or segment timestamps within this clip.');
    seen.add(key);
  }
}
interface CaptionGroup { start: number; end: number; text: string; words: Word[] }
function groups(segments: Segment[], edl: RetentionEdl, style: CaptionStyle, corrections: ClipRetention['captions']): CaptionGroup[] {
  const result: CaptionGroup[] = [];
  const corrected = (start: number, end: number, text: string) => corrections.find(c => c.start === start && c.end === end)?.text || text;
  for (const segment of segments) {
    if (segment.end <= edl.sourceStart || segment.start >= edl.sourceEnd) continue;
    const segmentCorrection = corrections.find(c => c.start === segment.start && c.end === segment.end);
    const words = alignedWords([segment]).filter(w => w.start >= edl.sourceStart && w.end <= edl.sourceEnd).map(w => ({ ...w, word: corrected(w.start, w.end, w.word) }));
    if (!words.length || segmentCorrection) {
      // Segment-only timestamps are kept honest: no synthetic per-word timing.
      const text = escapeText(segmentCorrection?.text || segment.text);
      if (text) result.push({ start: outputTime(edl, Math.max(segment.start, edl.sourceStart)), end: outputTime(edl, Math.min(segment.end, edl.sourceEnd)), text, words: [] });
      continue;
    }
    let group: Word[] = [];
    const flush = () => {
      if (!group.length) return;
      result.push({ start: outputTime(edl, group[0]!.start), end: outputTime(edl, group.at(-1)!.end), text: group.map(w => escapeText(w.word)).join(' '), words: group }); group = [];
    };
    for (const word of words) {
      if (group.length && (group.length >= style.wordsPerGroup || word.end - group[0]!.start > 3.5 || [...group, word].map(w => w.word).join(' ').length > 32 || word.start - group.at(-1)!.end > 0.6)) flush();
      group.push(word); if (/[.!?]$/.test(word.word.trim())) flush();
    }
    flush();
  }
  return result.filter(g => g.end > g.start);
}
export function createAss(segments: Segment[], edl: RetentionEdl, style: CaptionStyle, corrections: ClipRetention['captions']): string {
  const alignment = style.position === 'upper' ? 8 : style.position === 'middle' ? 5 : 2;
  const margin = style.position === 'upper' ? 280 : 420;
  let ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Caption,${style.font},${style.size},${color(style.animation === 'karaoke' ? style.highlight : style.color)},${color(style.color)},&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${style.outline},0,${alignment},100,180,${margin},1\nStyle: Overlay,${style.font},${style.size},${color(style.color)},${color(style.color)},&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${style.outline},0,8,100,180,280,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  if (style.enabled) for (const group of groups(segments, edl, style, corrections)) {
    let text = escapeText(group.text);
    if (style.animation === 'karaoke' && group.words.length) {
      let cursor = group.start;
      text = group.words.map(w => {
        const start = outputTime(edl, w.start); const end = outputTime(edl, w.end);
        const gap = Math.max(0, Math.round((start - cursor) * 100)); cursor = end;
        return `${gap ? `{\\k${gap}} ` : ''}{\\kf${Math.max(1, Math.round((end - start) * 100))}}${escapeText(w.word)}`;
      }).join(' ');
    } else if (style.animation === 'karaoke') text = `{\\c${color(style.color)}&}${text}`;
    if (style.animation === 'fade') text = `{\\fad(80,80)}${text}`;
    ass += `Dialogue: 0,${assTime(group.start)},${assTime(group.end)},Caption,,0,0,0,,${text}\n`;
  }
  for (const action of edl.actions.filter(a => a.type === 'hook-text' || a.type === 'cta')) {
    ass += `Dialogue: 1,${assTime(outputTime(edl, action.start))},${assTime(outputTime(edl, action.end))},Overlay,,0,0,0,,{\\fad(100,100)}${escapeText(action.text || '')}\n`;
  }
  return ass;
}
export function createRetentionSrt(segments: Segment[], edl: RetentionEdl, style: CaptionStyle, corrections: ClipRetention['captions']): string {
  const stamp = (time: number) => { const ms = Math.round(time * 1000); return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
  return groups(segments, edl, style, corrections).map((g, i) => `${i + 1}\n${stamp(g.start)} --> ${stamp(g.end)}\n${g.text}\n`).join('\n');
}
