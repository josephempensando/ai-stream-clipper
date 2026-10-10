import 'dotenv/config';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ffmpegStatic: unknown = require('ffmpeg-static');
const ffprobeStatic: { path: string } = require('ffprobe-static');

function positive(name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number(process.env[name] || fallback);
  if (!Number.isFinite(n) || n < 1 || n > max) throw new Error(`Invalid ${name}`);
  return n;
}
export const config = {
  host: process.env.HOST || '127.0.0.1', port: positive('PORT', 3001, 65535),
  dataDir: path.resolve(process.env.DATA_DIR || 'data'),
  ffmpeg: process.env.FFMPEG_PATH || (typeof ffmpegStatic === 'string' ? ffmpegStatic : 'ffmpeg'),
  ffprobe: process.env.FFPROBE_PATH || ffprobeStatic.path || 'ffprobe',
  ffmpegConcurrency: positive('FFMPEG_CONCURRENCY', 1, 4),
  whisper: process.env.WHISPER_PATH || 'whisper', whisperModel: process.env.WHISPER_MODEL || 'base',
  whisperLanguage: process.env.WHISPER_LANGUAGE || 'en', chunkSeconds: positive('WHISPER_CHUNK_SECONDS', 600, 1800),
  whisperTimeout: positive('WHISPER_TIMEOUT_MS', 7_200_000),
  ollamaUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
  ollamaModel: process.env.OLLAMA_MODEL || 'llama3.2:3b', vision: process.env.OLLAMA_VISION === 'true',
  ollamaTimeout: positive('OLLAMA_TIMEOUT_MS', 180_000),
  ollamaContextTokens: positive('OLLAMA_NUM_CTX', 4096, 131072),
  maxBytes: positive('MAX_UPLOAD_GB', 20, 100) * 1024 ** 3,
  approvedHosts: (process.env.APPROVED_MEDIA_HOSTS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean),
  twitchClientId: process.env.TWITCH_CLIENT_ID || '', twitchSecret: process.env.TWITCH_CLIENT_SECRET || '',
  twitchUserToken: process.env.TWITCH_USER_ACCESS_TOKEN || '',
  twitchRedirectUri: process.env.TWITCH_REDIRECT_URI || 'http://127.0.0.1:5173/api/twitch/oauth/callback',
  twitchAppOrigin: process.env.TWITCH_APP_ORIGIN || 'http://127.0.0.1:5173',
  youtubeApiKey: process.env.YOUTUBE_API_KEY || '',
  transcriptOllamaModel: process.env.TRANSCRIPT_OLLAMA_MODEL || 'llama3.2',
};
// This MVP is a local tool, not an authenticated multi-user service.
if (!['127.0.0.1', '::1', 'localhost'].includes(config.host)) throw new Error('HOST must be loopback for this local MVP.');
const ollama = new URL(config.ollamaUrl);
if (config.ollamaContextTokens < 2048) throw new Error('OLLAMA_NUM_CTX must be at least 2048.');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(ollama.hostname) || !['http:', 'https:'].includes(ollama.protocol)) throw new Error('Ollama must be a local endpoint.');
