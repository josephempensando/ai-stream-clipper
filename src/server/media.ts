import { readFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { config } from './config.js';
import { runProcess, Semaphore } from './process.js';
import type { Evidence, MediaInfo } from '../shared/types.js';

export const ffmpegQueue = new Semaphore(config.ffmpegConcurrency);
export function ffmpeg(args: string[], onLine?: (line: string) => void, signal?: AbortSignal): Promise<string> {
  return ffmpegQueue.run(() => runProcess(config.ffmpeg, ['-hide_banner', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', ...args], { ...(onLine ? { onLine } : {}), ...(signal ? { signal } : {}) }), signal);
}
const probeSchema = z.object({
  format: z.object({ duration: z.coerce.number().finite().positive(), format_name: z.string() }),
  streams: z.array(z.object({ codec_type: z.string(), width: z.number().optional(), height: z.number().optional() })),
});
async function inspectMedia(file: string, signal?: AbortSignal): Promise<{ media: MediaInfo; formats: string[] }> {
  const data = probeSchema.parse(JSON.parse(await runProcess(config.ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_format', '-show_streams', '-of', 'json', file], { timeout: 60_000, ...(signal ? { signal } : {}) })));
  const video = data.streams.find(s => s.codec_type === 'video');
  if (!video) {
    throw new Error(data.streams.some(s => s.codec_type === 'audio')
      ? 'This file contains only audio and no video track. Upload the original video recording.'
      : 'This file has no video track. Upload an MP4 recording containing video.');
  }
  if (!video.width || !video.height) throw new Error('The video track has no readable dimensions. Re-export the original video as an MP4 with H.264 video and try again.');
  return { formats: data.format.format_name.split(','), media: { duration: data.format.duration, width: video.width, height: video.height, hasAudio: data.streams.some(s => s.codec_type === 'audio') } };
}
function requireMp4(formats: string[]): void {
  if (!formats.includes('mp4')) throw new Error(`Detected ${formats.join(',')} container. Convert the video to MP4 and try again; changing the filename extension does not convert the file.`);
}
export async function probe(file: string, signal?: AbortSignal): Promise<MediaInfo> {
  const inspected = await inspectMedia(file, signal); requireMp4(inspected.formats); return inspected.media;
}
export async function prepareRecording(file: string): Promise<{ file: string; media: MediaInfo; remuxed: boolean }> {
  const inspected = await inspectMedia(file);
  if (inspected.formats.includes('mp4')) return { file, media: inspected.media, remuxed: false };
  if (!inspected.formats.includes('mpegts')) requireMp4(inspected.formats);
  const output = `${file}.remux.mp4`;
  try {
    // Stream copy repackages transport streams without re-encoding their content.
    await ffmpeg(['-fflags', '+genpts', '-i', file, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', '-f', 'mp4', output]);
    return { file: output, media: await probe(output), remuxed: true };
  } catch (error) {
    await rm(output, { force: true });
    throw new Error(`Could not repackage this MPEG-TS recording as MP4. Re-export it with H.264 video and AAC audio. ${error instanceof Error ? error.message : ''}`);
  }
}
export async function extractAudio(file: string, output: string, start: number, duration: number): Promise<void> {
  await ffmpeg(['-ss', String(start), '-i', file, '-t', String(duration), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', output]);
}
export async function detectEvidence(file: string): Promise<Evidence[]> {
  const bins = new Map<number, Evidence>(); let audioTime = 0; let sceneTime = 0;
  const at = (time: number) => {
    const key = Math.floor(time); const item = bins.get(key) || { time: key, loudness: -90, scene: false }; bins.set(key, item); return item;
  };
  // Log metadata incrementally instead of buffering a multi-hour FFmpeg log.
  await ffmpeg(['-i', file, '-vn', '-af', 'aresample=16000,asetnsamples=n=16000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level', '-f', 'null', '-'], line => {
    const time = /pts_time:([\d.]+)/.exec(line); if (time) audioTime = Number(time[1]);
    const rms = /lavfi.astats.Overall.RMS_level=(-?[\d.]+|-inf)/.exec(line);
    if (rms) at(audioTime).loudness = Number.isFinite(Number(rms[1])) ? Number(rms[1]) : -90;
  });
  await ffmpeg(['-i', file, '-an', '-vf', "fps=2,scale=160:-2,select='gt(scene,0.3)',showinfo", '-f', 'null', '-'], line => {
    const time = /pts_time:([\d.]+)/.exec(line); if (time) { sceneTime = Number(time[1]); at(sceneTime).scene = true; }
  });
  return [...bins.values()].sort((a, b) => a.time - b.time);
}
export async function sampleFrame(file: string, time: number, output: string): Promise<string> {
  await mkdir(path.dirname(output), { recursive: true });
  await ffmpeg(['-ss', String(time), '-i', file, '-frames:v', '1', '-vf', 'scale=512:-2', '-q:v', '4', output]);
  return (await readFile(output)).toString('base64');
}
