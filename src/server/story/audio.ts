import { config } from '../config.js';
import { runProcess } from '../process.js';
export async function probeAudio(file: string, signal?: AbortSignal): Promise<{ duration: number; sampleRate: number; channels: number }> {
  const data = JSON.parse(await runProcess(config.ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_format', '-show_streams', '-of', 'json', file], { timeout: 60_000, ...(signal ? { signal } : {}) }));
  const audio = data.streams?.find((s: { codec_type: string }) => s.codec_type === 'audio');
  const duration = Number(data.format?.duration); const sampleRate = Number(audio?.sample_rate); const channels = Number(audio?.channels);
  if (!audio || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isFinite(channels) || channels <= 0) throw new Error('Empty or unreadable audio output.');
  return { duration, sampleRate, channels };
}
