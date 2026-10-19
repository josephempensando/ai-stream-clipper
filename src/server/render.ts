import { mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { ffmpeg } from './media.js';
import { createSrt } from './subtitles.js';
import type { ClipEdit, Job, OutputClip, RenderOptions, Transcript } from '../shared/types.js';
import { validateEdits } from '../shared/validation.js';
import { writeJson } from './store.js';
import { runProcess } from './process.js';
import { config } from './config.js';
import { ffmpegQueue } from './media.js';
import { assessRights, normalizeRights } from '../shared/rights.js';
import { highlightDetails } from '../shared/highlights.js';
import { buildEdl } from './retention.js';
import { renderRetention } from './retention-render.js';
import { validateCorrections } from './retention-captions.js';
import type { Evidence } from '../shared/types.js';
import type { RetentionEdl } from '../shared/retention.js';
import { readJson } from './store.js';

export function prepareRetention(job: Job, edit: ClipEdit, options: RenderOptions, transcript: Transcript, evidence: Evidence[] = []): { edl: RetentionEdl; options: RenderOptions } {
  const h = job.highlights.find(h => h.id === edit.id)!;
  const base = options.retention!;
  const settings = { ...base, ...(edit.adjustments?.ending ? { ending: edit.adjustments.ending } : {}), ...(edit.adjustments?.patternInterrupts !== undefined ? { patternInterrupts: edit.adjustments.patternInterrupts } : {}) };
  validateCorrections(transcript.segments, edit.adjustments?.captions || [], edit.start, edit.end);
  if (settings.ending === 'cta' && !settings.cta.trim()) throw new Error('Enter one relevant CTA or choose natural payoff.');
  if (settings.autoEdit || settings.ending === 'loop') {
    if (!h.retention || h.start !== edit.start || h.end !== edit.end) throw new Error('Regenerate retention analysis for these exact clip boundaries before export.');
    return { edl: buildEdl(h, h.retention.narrative, evidence, settings), options: { ...options, retention: settings } };
  }
  const edl: RetentionEdl = { version: 1, sourceStart: edit.start, sourceEnd: edit.end, duration: edit.end - edit.start, keep: [{ start: edit.start, end: edit.end }], actions: [{ type: 'keep', start: edit.start, end: edit.end, reason: 'Creator-selected chronological interval; automatic edits disabled.' }], recommendations: [] };
  if (settings.normalize) edl.actions.push({ type: 'normalize', start: edit.start, end: edit.end, reason: `Dialogue target ${settings.dialogueLufs} LUFS with true-peak limiting.` });
  if (settings.musicId) edl.actions.push({ type: 'music', start: edit.start, end: edit.end, reason: `Approved audio asset ${settings.musicId}, speech-sidechain ducking and ${settings.musicGainDb} dB gain.` });
  if (settings.ending === 'cta') edl.actions.push({ type: 'cta', start: Math.max(edit.start, edit.end - 2.5), end: edit.end, text: settings.cta, reason: 'One creator-written CTA over the intact ending.' });
  return { edl, options: { ...options, retention: settings } };
}

export function videoFilter(options: RenderOptions): string {
  if (options.layout === 'crop') return `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:(iw-1080)*${options.cropX}:0,setsar=1[outv]`;
  return '[0:v]split=2[bg][fg];[bg]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=12:2,scale=1080:1920[blur];[fg]scale=1080:1920:force_original_aspect_ratio=decrease[front];[blur][front]overlay=(W-w)/2:(H-h)/2,setsar=1[outv]';
}
export async function renderClips(job: Job, source: string, dir: string, edits: ClipEdit[], options: RenderOptions, transcript: Transcript, progress: (stage: string, percent: number) => Promise<void>): Promise<OutputClip[]> {
  validateEdits(edits, job.media.duration);
  if (edits.some(e => !job.highlights.some(h => h.id === e.id))) throw new Error('Unknown highlight ID.');
  await mkdir(dir, { recursive: true });
  const outputs: OutputClip[] = [];
  const decisions: Record<string, RetentionEdl> = {};
  const evidence = await readJson<Evidence[]>(path.join(dir, '..', 'evidence.json')) || [];
  for (const [index, edit] of edits.entries()) {
    const stem = `clip-${String(index + 1).padStart(2, '0')}`; const file = `${stem}.mp4`;
    const part = path.join(dir, `${stem}.partial.mp4`); const target = path.join(dir, file);
    await progress(`Rendering clip ${index + 1} of ${edits.length}`, Math.round(index / edits.length * 100));
    if (options.retention) {
      const prepared = prepareRetention(job, edit, options, transcript, evidence); decisions[edit.id] = prepared.edl;
      await renderRetention(source, dir, stem, { ...job.highlights.find(h => h.id === edit.id)!, start: edit.start, end: edit.end }, prepared.edl, prepared.options, transcript,
        (job.audioAssets || []).map(a => ({ ...a, file: path.join(dir, '..', 'audio', `${a.id}.bin`) })), edit.adjustments?.captions || [],
        percent => progress(`Rendering clip ${index + 1} of ${edits.length}`, (index + percent / 100) / edits.length * 100));
      outputs.push({ id: edit.id, start: edit.start, end: edit.end, title: job.highlights.find(h => h.id === edit.id)!.title, file });
      continue;
    }
    const args = ['-ss', String(edit.start), '-i', source, '-t', String(edit.end - edit.start), '-filter_complex', videoFilter(options), '-map', '[outv]', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-threads', '2', '-r', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-af', 'aresample=async=1:first_pts=0', '-movflags', '+faststart', part];
    await ffmpeg(args);
    if (options.subtitles) {
      const srt = `${stem}.srt`; await writeFile(path.join(dir, srt), createSrt(transcript.segments, edit.start, edit.end));
      // Relative safe generated names avoid Windows drive-letter filter escaping.
      // Match subtitle coordinates to the export: SRT's default 384x288 script
      // otherwise magnifies both the font and bottom margin in portrait video.
      const style = 'PlayResX=1080,PlayResY=1920,FontName=Arial,FontSize=48,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Shadow=1,Alignment=2,MarginL=80,MarginR=80,MarginV=120';
      await ffmpegQueue.run(() => runProcess(config.ffmpeg, ['-hide_banner', '-nostdin', '-y', '-i', `${stem}.partial.mp4`, '-vf', `subtitles=${srt}:force_style='${style}'`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-threads', '2', '-c:a', 'copy', '-movflags', '+faststart', file], { cwd: dir }));
    } else await rename(part, target);
    outputs.push({ id: edit.id, start: edit.start, end: edit.end, title: job.highlights.find(h => h.id === edit.id)!.title, file });
  }
  const exportedHighlights = edits.map(e => {
    const original = job.highlights.find(h => h.id === e.id)!;
    const { retention, ...base } = original;
    const currentNarrative = retention && original.start === e.start && original.end === e.end ? { retention: { narrative: retention.narrative, edl: decisions[e.id] || retention.edl } } : {};
    return { ...highlightDetails({ ...base, ...currentNarrative, start: e.start, end: e.end, cues: transcript.segments.filter(s => s.end > e.start && s.start < e.end), transcript: transcript.segments.filter(s => s.end > e.start && s.start < e.end).map(s => s.text).join(' ') }), vodStart: e.start + job.vodOffset, vodEnd: e.end + job.vodOffset };
  });
  await writeJson(path.join(dir, 'results.json'), {
    version: 1, jobId: job.id, source: job.source, name: job.name, mediaHash: job.mediaHash,
    vodId: job.vodId, vodOffset: job.vodOffset, durationMode: 'auto', clipCount: job.clipCount ?? config.clipCount, minEngagementScore: job.minEngagementScore ?? config.minEngagementScore ?? 70,
    models: { whisper: transcript.model, ollama: transcript.model === 'test-double' ? 'test-double' : config.ollamaModel, vision: config.vision },
    resolution: '1080x1920', options, warnings: job.warnings, highlights: exportedHighlights, outputs, editDecisionLists: decisions, captionCorrections: edits.map(e => ({ id: e.id, captions: e.adjustments?.captions || [] })), audioAssets: job.audioAssets || [],
    purpose: 'draft', rights: normalizeRights(job.rights), rightsAssessment: assessRights(job.rights), rightsSnapshotAt: new Date().toISOString(),
    notice: 'Draft rendering does not establish publishing rights or legal clearance.',
  });
  return outputs;
}
