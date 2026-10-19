import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { Highlight, RenderOptions, Transcript } from '../shared/types.js';
import type { AudioAsset, ClipRetention, RetentionEdl } from '../shared/retention.js';
import { outputTime } from './retention.js';
import { createAss, createRetentionSrt, validateCorrections } from './retention-captions.js';
import { videoFilter } from './render.js';
import { config } from './config.js';
import { ffmpegQueue } from './media.js';
import { runProcess } from './process.js';

export interface RenderAsset extends AudioAsset { file: string }
export function retentionGraph(edl: RetentionEdl, options: RenderOptions, music: boolean, sfx: boolean, subtitlesFile?: string): string {
  const settings = options.retention!;
  const graph: string[] = []; const count = edl.keep.length;
  // Preserve the source video clock while removing gaps. AV concat pads each
  // video tail to a frame and accumulates drift across fractional-frame cuts.
  const selected = edl.keep.map(s => `gte(t,${s.start - edl.sourceStart})*lt(t,${s.end - edl.sourceStart})`).join('+');
  const removed = edl.keep.slice(1).map((s, i) => `if(gte(T,${s.start - edl.sourceStart}),${s.start - edl.keep[i]!.end},0)`).join('+') || '0';
  graph.push(`[0:v]select='${selected}',setpts='PTS-(${removed})/TB'[vcat]`, `[0:a]asplit=${count}${edl.keep.map((_, i) => `[ain${i}]`).join('')}`);
  for (const [i, span] of edl.keep.entries()) {
    const start = span.start - edl.sourceStart; const end = span.end - edl.sourceStart;
    graph.push(`[ain${i}]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${i}]`);
  }
  graph.push(`${edl.keep.map((_, i) => `[a${i}]`).join('')}concat=n=${count}:v=0:a=1[acat]`);
  graph.push(videoFilter(options).replace('[0:v]', '[vcat]').replace('[outv]', '[base]'));
  const punches = edl.actions.filter(a => a.type === 'punch-in');
  const active = punches.map(a => `between(on/${settings.fps},${outputTime(edl, a.start)},${outputTime(edl, a.end)})`).join('+') || '0';
  graph.push(`[base]fps=${settings.fps},zoompan=z='if(${active},1.06,1)':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=1080x1920:fps=${settings.fps},setsar=1[zoomed]`);
  let visual = 'zoomed';
  if (edl.actions.some(a => a.type === 'loop')) {
    const start = Math.max(0, edl.duration - 0.12);
    graph.push(`[zoomed]split=2[tail][head]`, `[head]trim=duration=0.12,setpts=PTS-STARTPTS+${start}/TB,format=yuva420p,fade=t=in:st=${start}:d=0.12:alpha=1[loophead]`, '[tail][loophead]overlay=eof_action=pass[looped]'); visual = 'looped';
  }
  graph.push(`[${visual}]${subtitlesFile ? `ass=${subtitlesFile}` : 'null'}[outv]`);
  graph.push(`[acat]aresample=48000:async=1:first_pts=0${settings.normalize ? `,loudnorm=I=${settings.dialogueLufs}:TP=-1.5:LRA=11` : ''}[dialogue]`);
  let audio = 'dialogue'; let index = 1;
  if (music) {
    graph.push('[dialogue]asplit=2[voice][detector]', `[${index++}:a]atrim=duration=${edl.duration},asetpts=PTS-STARTPTS,aresample=48000,volume=${settings.musicGainDb}dB[music]`, '[music][detector]sidechaincompress=threshold=0.025:ratio=8:attack=20:release=350[ducked]', '[voice][ducked]amix=inputs=2:duration=first:normalize=0[mixed]'); audio = 'mixed';
  }
  const effects = edl.actions.filter(a => a.type === 'sfx');
  if (sfx && effects.length) {
    graph.push(`[${index}:a]asplit=${effects.length}${effects.map((_, i) => `[fxin${i}]`).join('')}`);
    for (const [i, action] of effects.entries()) graph.push(`[fxin${i}]atrim=duration=${action.end - action.start},asetpts=PTS-STARTPTS,aresample=48000,volume=${settings.sfxGainDb}dB,adelay=${Math.round(outputTime(edl, action.start) * 1000)}:all=1[fx${i}]`);
    graph.push(`[${audio}]${effects.map((_, i) => `[fx${i}]`).join('')}amix=inputs=${effects.length + 1}:duration=first:normalize=0[withfx]`); audio = 'withfx';
  }
  // Limiter latency compensation preserves AV alignment, even with all FX disabled.
  graph.push(`[${audio}]alimiter=limit=0.95:level=0:latency=1,apad,atrim=duration=${edl.duration},asetpts=PTS-STARTPTS[outa]`);
  return graph.join(';');
}

export async function renderRetention(source: string, dir: string, stem: string, h: Highlight, edl: RetentionEdl, options: RenderOptions, transcript: Transcript, assets: RenderAsset[], corrections: ClipRetention['captions'], progress: (percent: number) => Promise<void>): Promise<void> {
  const settings = options.retention!;
  validateCorrections(transcript.segments, corrections, h.start, h.end);
  const music = settings.musicId ? assets.find(a => a.id === settings.musicId && a.kind === 'music' && a.permission) : undefined;
  const sfx = settings.sfxId ? assets.find(a => a.id === settings.sfxId && a.kind === 'sfx' && a.permission) : undefined;
  if (settings.musicId && !music || settings.sfxId && !sfx) throw new Error('Audio asset is unavailable or lacks a rights/provenance record.');
  const assName = `${stem}.ass`;
  await writeFile(path.join(dir, assName), createAss(transcript.segments, edl, settings.captions, corrections));
  await writeFile(path.join(dir, `${stem}.srt`), createRetentionSrt(transcript.segments, edl, settings.captions, corrections));
  await writeFile(path.join(dir, `${stem}.edl.json`), JSON.stringify(edl, null, 2));
  const args = ['-hide_banner', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-ss', String(h.start), '-t', String(h.end - h.start), '-i', source];
  if (music) args.push('-protocol_whitelist', 'file,pipe', '-stream_loop', '-1', '-i', music.file);
  if (sfx) args.push('-protocol_whitelist', 'file,pipe', '-i', sfx.file);
  args.push('-filter_complex_threads', '1', '-filter_complex', retentionGraph(edl, options, !!music, !!sfx, assName), '-map', '[outv]', '-map', '[outa]', '-t', String(edl.duration), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-threads', '2', '-r', String(settings.fps), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-b:a', '192k', '-movflags', '+faststart', '-progress', 'pipe:2', `${stem}.mp4`);
  let pending = Promise.resolve(); let lastPercent = -1;
  await ffmpegQueue.run(() => runProcess(config.ffmpeg, args, { cwd: dir, onLine: line => {
    const match = /^out_time_us=(\d+)/.exec(line); if (!match) return;
    const percent = Math.min(99, Math.floor(Number(match[1]) / 1e6 / edl.duration * 100));
    if (percent <= lastPercent) return; lastPercent = percent; pending = pending.then(() => progress(percent));
  } }));
  await pending; await progress(100);
}
