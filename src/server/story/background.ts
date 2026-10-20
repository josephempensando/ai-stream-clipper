import path from 'node:path';
import { ffmpeg, probe } from '../media.js';
import { probeAudio } from './audio.js';
import type { StorySettings } from '../../shared/story.js';
export interface BackgroundFit { mode: 'trim' | 'slow' | 'loop'; playbackRate: number; dissolveSeconds: number }
export async function prepareMusicLoop(file: string, workDir: string, duration: number, signal: AbortSignal): Promise<string> {
  const source = await probeAudio(file, signal); if (source.duration >= duration) return file;
  const length = source.duration; const d = Math.min(0.25, length / 4);
  if (d < 0.02) throw new Error('Music is too short for a smooth loop. Choose a longer audio file.');
  const output = path.join(workDir, 'music-loop.wav');
  // Separate bounded readers prevent an early head EOF from starving the tail.
  const graph = `[0:a]atrim=start=${d}:end=${length - d},asetpts=PTS-STARTPTS[mid];[1:a]atrim=start=${length - d}:end=${length},asetpts=PTS-STARTPTS[tail];[2:a]atrim=end=${d},asetpts=PTS-STARTPTS[head];[tail][head]acrossfade=d=${d}[seam];[mid][seam]concat=n=2:v=0:a=1[a]`;
  await ffmpeg(['-i', file, '-i', file, '-i', file, '-filter_complex', graph, '-map', '[a]', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', output], undefined, signal); return output;
}
export function planBackground(backgroundDuration: number, narrationDuration: number, fitMode: StorySettings['fitMode']): BackgroundFit {
  if (![backgroundDuration, narrationDuration].every(n => Number.isFinite(n) && n > 0)) throw new Error('Invalid media duration.');
  if (backgroundDuration >= narrationDuration) return { mode: 'trim', playbackRate: 1, dissolveSeconds: 0 };
  const rate = fitMode === 'slow-loop' ? 0.75 : fitMode === 'auto' && backgroundDuration / narrationDuration >= 0.75 ? backgroundDuration / narrationDuration : 1;
  if (backgroundDuration / rate >= narrationDuration - 0.001) return { mode: 'slow', playbackRate: rate, dissolveSeconds: 0 };
  const length = backgroundDuration / rate; const dissolveSeconds = Math.floor(Math.min(0.4, length / 4) * 30) / 30;
  if (dissolveSeconds < 1 / 30) throw new Error('Background video is too short for a smooth loop. Upload at least one second of footage.');
  return { mode: 'loop', playbackRate: rate, dissolveSeconds };
}
export async function prepareStoryBackground(input: { video: string; music?: string; duration: number; settings: StorySettings; workDir: string }, signal: AbortSignal): Promise<{ videoFile: string; bedFile?: string }> {
  const media = await probe(input.video, signal); signal.throwIfAborted();
  const fit = planBackground(media.duration, input.duration, input.settings.fitMode);
  const normalized = path.join(input.workDir, 'background-normalized.mp4');
  const audio = media.hasAudio && !input.settings.backgroundMuted;
  const filters = `setpts=(PTS-STARTPTS)/${fit.playbackRate},fps=30,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:(iw-ow)*${input.settings.cropX}:(ih-oh)/2,setsar=1`;
  const blurFilters = `setpts=(PTS-STARTPTS)/${fit.playbackRate},fps=30,split=2[b][f];[b]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=30:3[bg];[f]scale=1080:1920:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1`;
  await ffmpeg(['-i', input.video, '-filter_complex_threads', '1', '-vf', input.settings.layout === 'blur' ? blurFilters : filters, ...(audio ? ['-af', `atempo=${fit.playbackRate},aresample=48000,asetpts=PTS-STARTPTS`] : ['-an']), '-t', String(Math.min(media.duration / fit.playbackRate, input.duration)), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-threads', '2', '-pix_fmt', 'yuv420p', ...(audio ? ['-c:a', 'aac', '-ar', '48000'] : []), normalized], undefined, signal);
  let videoFile = normalized;
  if (fit.mode === 'loop') {
    const length = (await probe(normalized, signal)).duration; const d = fit.dissolveSeconds;
    videoFile = path.join(input.workDir, 'background-loop.mp4');
    let graph = `[0:v]trim=start=${d}:end=${length - d},setpts=PTS-STARTPTS[mid];[1:v]trim=start=${length - d}:end=${length},setpts=PTS-STARTPTS[tail];[2:v]trim=end=${d},setpts=PTS-STARTPTS[head];[tail][head]xfade=transition=fade:duration=${d}:offset=0[seam];[mid][seam]concat=n=2:v=1:a=0[v]`;
    if (audio) graph += `;[0:a]atrim=start=${d}:end=${length - d},asetpts=PTS-STARTPTS[amid];[1:a]atrim=start=${length - d}:end=${length},asetpts=PTS-STARTPTS[atail];[2:a]atrim=end=${d},asetpts=PTS-STARTPTS[ahead];[atail][ahead]acrossfade=d=${d}[aseam];[amid][aseam]concat=n=2:v=0:a=1[a]`;
    await ffmpeg(['-i', normalized, '-i', normalized, '-i', normalized, '-filter_complex_threads', '1', '-filter_complex', graph, '-map', '[v]', ...(audio ? ['-map', '[a]', '-c:a', 'aac'] : []), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-threads', '2', '-r', '30', '-pix_fmt', 'yuv420p', videoFile], undefined, signal);
  }
  let bedFile: string | undefined;
  if (input.music || audio) {
    const args: string[] = []; const beds: string[] = [];
    if (audio) { args.push('-stream_loop', '-1', '-i', videoFile); beds.push(`[0:a]volume=${input.settings.backgroundGainDb}dB[bed0]`); }
    if (input.music) { const music = await prepareMusicLoop(input.music, input.workDir, input.duration, signal); const index = audio ? 1 : 0; args.push('-stream_loop', '-1', '-i', music); beds.push(`[${index}:a]volume=${input.settings.musicGainDb}dB[bed${index}]`); }
    const count = beds.length; const mixed = count === 2 ? '[bed0][bed1]amix=inputs=2:normalize=0' : '[bed0]anull';
    bedFile = path.join(input.workDir, 'bed.wav');
    await ffmpeg([...args, '-filter_complex', `${beds.join(';')};${mixed},afade=t=out:st=${Math.max(0, input.duration - 0.08)}:d=0.08[bed]`, '-map', '[bed]', '-t', String(input.duration), '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', bedFile], undefined, signal);
  }
  return { videoFile, ...(bedFile ? { bedFile } : {}) };
}
