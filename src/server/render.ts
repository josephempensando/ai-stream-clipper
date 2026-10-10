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

export function videoFilter(options: RenderOptions): string {
  if (options.layout === 'crop') return `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:(iw-1080)*${options.cropX}:0,setsar=1[outv]`;
  return '[0:v]split=2[bg][fg];[bg]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=12:2,scale=1080:1920[blur];[fg]scale=1080:1920:force_original_aspect_ratio=decrease[front];[blur][front]overlay=(W-w)/2:(H-h)/2,setsar=1[outv]';
}
export async function renderClips(job: Job, source: string, dir: string, edits: ClipEdit[], options: RenderOptions, transcript: Transcript, progress: (stage: string, percent: number) => Promise<void>): Promise<OutputClip[]> {
  validateEdits(edits, job.media.duration);
  if (edits.some(e => !job.highlights.some(h => h.id === e.id))) throw new Error('Unknown highlight ID.');
  await mkdir(dir, { recursive: true });
  const outputs: OutputClip[] = [];
  for (const [index, edit] of edits.entries()) {
    const stem = `clip-${String(index + 1).padStart(2, '0')}`; const file = `${stem}.mp4`;
    const part = path.join(dir, `${stem}.partial.mp4`); const target = path.join(dir, file);
    await progress(`Rendering clip ${index + 1} of ${edits.length}`, Math.round(index / edits.length * 100));
    const args = ['-ss', String(edit.start), '-i', source, '-t', String(edit.end - edit.start), '-filter_complex', videoFilter(options), '-map', '[outv]', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-threads', '2', '-r', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-af', 'aresample=async=1:first_pts=0', '-movflags', '+faststart', part];
    await ffmpeg(args);
    if (options.subtitles) {
      const srt = `${stem}.srt`; await writeFile(path.join(dir, srt), createSrt(transcript.segments, edit.start, edit.end));
      // Relative safe generated names avoid Windows drive-letter filter escaping.
      await ffmpegQueue.run(() => runProcess(config.ffmpeg, ['-hide_banner', '-nostdin', '-y', '-i', `${stem}.partial.mp4`, '-vf', `subtitles=${srt}:force_style='FontSize=20,Outline=2,MarginV=60'`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-threads', '2', '-c:a', 'copy', '-movflags', '+faststart', file], { cwd: dir }));
    } else await rename(part, target);
    outputs.push({ id: edit.id, start: edit.start, end: edit.end, title: job.highlights.find(h => h.id === edit.id)!.title, file });
  }
  const exportedHighlights = edits.map(e => ({ ...job.highlights.find(h => h.id === e.id)!, start: e.start, end: e.end, vodStart: e.start + job.vodOffset, vodEnd: e.end + job.vodOffset }));
  await writeJson(path.join(dir, 'results.json'), { version: 1, jobId: job.id, source: job.source, name: job.name, mediaHash: job.mediaHash, vodId: job.vodId, vodOffset: job.vodOffset, models: { whisper: transcript.model, ollama: transcript.model === 'test-double' ? 'test-double' : config.ollamaModel, vision: config.vision }, resolution: '1080x1920', options, warnings: job.warnings, highlights: exportedHighlights, outputs });
  return outputs;
}
