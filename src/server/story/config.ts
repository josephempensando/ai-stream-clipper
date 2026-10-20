import 'dotenv/config';
import path from 'node:path';

function integer(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}
export const storyConfig = {
  python: process.env.PIPER_PYTHON || path.resolve('.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
  voicesDir: path.resolve(process.env.PIPER_VOICES_DIR || 'data/piper-voices'),
  defaultVoice: process.env.PIPER_DEFAULT_VOICE || 'en_US-lessac-medium',
  timeout: integer('PIPER_TIMEOUT_MS', 180_000, 1000, 7_200_000),
  maxScriptCharacters: integer('STORY_MAX_SCRIPT_CHARS', 30_000, 1, 100_000),
  chunkCharacters: integer('STORY_TTS_CHUNK_CHARS', 800, 200, 2000),
};
