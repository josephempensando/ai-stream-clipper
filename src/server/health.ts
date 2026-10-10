import { z } from 'zod';
import { config } from './config.js';
import { runProcess } from './process.js';
import type { Health } from '../shared/types.js';

export async function health(): Promise<Health> {
  const command = async (file: string, args: string[]) => { try { await runProcess(file, args, { timeout: 6000 }); return true; } catch { return false; } };
  const ollama = async () => {
    try {
      const r = await fetch(`${config.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      const data = z.object({ models: z.array(z.object({ name: z.string() })) }).parse(await r.json());
      return r.ok && data.models.some(m => m.name === config.ollamaModel || m.name === `${config.ollamaModel}:latest`);
    } catch { return false; }
  };
  const [ffmpeg, ffprobe, whisper, available] = await Promise.all([command(config.ffmpeg, ['-version']), command(config.ffprobe, ['-version']), command(config.whisper, ['--help']), ollama()]);
  return { ffmpeg, ffprobe, whisper, ollama: available, model: config.ollamaModel, whisperModel: config.whisperModel, twitch: Boolean(config.twitchClientId && (config.twitchSecret || config.twitchUserToken)), clipAuth: Boolean(config.twitchClientId && config.twitchUserToken) };
}
