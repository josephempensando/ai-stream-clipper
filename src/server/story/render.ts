import path from 'node:path';
import { copyFile } from 'node:fs/promises';
import { ffmpegQueue, probe } from '../media.js';
import { config } from '../config.js';
import { runProcess } from '../process.js';
import type { StorySettings } from '../../shared/story.js';
export async function renderStory(input: { background: { videoFile: string; bedFile?: string }; narrationFile: string; narrationDuration: number; assFile?: string; outputDirectory: string; settings: StorySettings }, signal: AbortSignal, onEncodedTime: (seconds: number) => Promise<void>): Promise<{ videoFile: string; videoDuration: number }> {
  const args = ['-hide_banner', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-stream_loop', '-1', '-i', input.background.videoFile, '-i', input.narrationFile];
  if (input.background.bedFile) args.push('-i', input.background.bedFile);
  if (input.assFile) await copyFile(input.assFile, path.join(input.outputDirectory, 'render.ass'));
  let graph = `[0:v]setpts=PTS-STARTPTS${input.assFile ? ",ass=filename='render.ass'" : ''}[v];[1:a]aresample=48000,loudnorm=I=-16:TP=-1.5:LRA=11,apad[n]`;
  if (input.background.bedFile) graph += ';[n]asplit=2[voice][side];[2:a]apad[bed];[bed][side]sidechaincompress=threshold=0.025:ratio=8:attack=15:release=250[duck];[voice][duck]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95:latency=1[a]';
  else graph += ';[n]alimiter=limit=0.95:latency=1[a]';
  args.push('-filter_complex_threads', '1', '-filter_complex', graph, '-map', '[v]', '-map', '[a]', '-t', String(input.narrationDuration), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-threads', '2', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', '-progress', 'pipe:2', 'video.mp4');
  let pending = Promise.resolve(); let last = -1; let progressError: unknown;
  try {
    await ffmpegQueue.run(() => runProcess(config.ffmpeg, args, { cwd: input.outputDirectory, signal, onLine: line => { const match = /^out_time_us=(\d+)/.exec(line); if (!match) return; const seconds = Math.min(input.narrationDuration, Number(match[1]) / 1e6); const step = Math.floor(seconds); if (step > last) { last = step; pending = pending.then(async () => { if (!progressError) await onEncodedTime(seconds); }).catch(error => { progressError = error; }); } } }), signal);
  } finally { await pending; }
  if (progressError) throw progressError;
  signal.throwIfAborted();
  const videoFile = path.join(input.outputDirectory, 'video.mp4'); const media = await probe(videoFile, signal);
  if (media.width !== 1080 || media.height !== 1920 || !media.hasAudio || Math.abs(media.duration - input.narrationDuration) > 0.1) throw new Error('Rendered output failed dimensions, audio or duration validation.');
  const details = JSON.parse(await runProcess(config.ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_streams', '-of', 'json', videoFile], { signal, timeout: 60_000 }));
  const streams = details.streams as { codec_type: string; codec_name: string; start_time: string; duration: string; sample_rate?: string }[];
  const video = streams.find(s => s.codec_type === 'video'); const audio = streams.find(s => s.codec_type === 'audio');
  if (video?.codec_name !== 'h264' || audio?.codec_name !== 'aac' || Number(audio.sample_rate) !== 48000 || [video, audio].some(s => !Number.isFinite(Number(s.start_time)) || Math.abs(Number(s.start_time)) > 0.05 || !Number.isFinite(Number(s.duration)) || Math.abs(Number(s.duration) - input.narrationDuration) > 0.1)) throw new Error('Rendered output failed codec or audio/video synchronization validation.');
  return { videoFile, videoDuration: media.duration };
}
