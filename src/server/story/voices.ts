import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { voiceIdSchema, StoryRequestError } from '../../shared/story.js';
import type { PublicVoice, StoryReadiness } from '../../shared/story.js';
import { config } from '../config.js';
import { storyConfig } from './config.js';
import { runProcess } from '../process.js';
import { containedFile, safePath } from './paths.js';

export interface VoiceDefinition extends PublicVoice { modelPath: string; configPath: string; pitchSemitones?: number }
const entrySchema = z.object({ id: voiceIdSchema, label: z.string().trim().min(1).max(100), language: z.string().regex(/^[a-z]{2,3}$/), licenseUrl: z.url().refine(url => url.startsWith('https://')), model: z.string().min(1), config: z.string().min(1), permitted: z.literal(true), pitchSemitones: z.number().finite().min(-6).max(6).optional() }).strict();
export async function loadVoiceCatalog(directory: string): Promise<VoiceDefinition[]> {
  let text: string;
  try { text = await readFile(await containedFile(directory, 'voices.json'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const data = z.object({ voices: z.array(entrySchema).max(50) }).strict().parse(JSON.parse(text));
  const ids = new Set<string>();
  return Promise.all(data.voices.map(async entry => {
    if (ids.has(entry.id) || !entry.model.endsWith('.onnx') || entry.config !== `${entry.model}.json`) throw new StoryRequestError('VOICE_REGISTRY_INVALID', 'Invalid voice registry: each model requires its adjacent configuration.');
    ids.add(entry.id);
    const modelPath = safePath(directory, entry.model); const configPath = safePath(directory, entry.config);
    let installed = false;
    try {
      const model = await containedFile(directory, entry.model); const configuration = await containedFile(directory, entry.config);
      const info = JSON.parse(await readFile(configuration, 'utf8')) as { audio?: { sample_rate?: number } };
      installed = (await stat(model)).size > 0 && Number.isFinite(info.audio?.sample_rate) && (info.audio?.sample_rate || 0) > 0;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new StoryRequestError('VOICE_REGISTRY_INVALID', 'Voice files or configuration are invalid.'); }
    return { id: entry.id, label: entry.label, language: entry.language, licenseUrl: entry.licenseUrl, installed, modelPath, configPath, ...(entry.pitchSemitones === undefined ? {} : { pitchSemitones: entry.pitchSemitones }) };
  }));
}
export async function getStoryReadiness(): Promise<StoryReadiness> {
  const check = async (executable: string, args: string[]) => { try { await runProcess(executable, args, { timeout: 6000 }); return true; } catch { return false; } };
  const [piper, whisper, ffmpeg, ffprobe] = await Promise.all([
    check(storyConfig.python, ['-c', 'import piper']), check(config.whisper, ['--help']), check(config.ffmpeg, ['-version']), check(config.ffprobe, ['-version']),
  ]);
  let voices: VoiceDefinition[] = []; let setupError: string | undefined;
  try { voices = await loadVoiceCatalog(storyConfig.voicesDir); } catch { setupError = 'Check the local Piper voice registry and model files.'; }
  return { piper, whisper, ffmpeg, ffprobe, defaultVoiceId: storyConfig.defaultVoice, maxScriptCharacters: storyConfig.maxScriptCharacters,
    voices: voices.map(({ modelPath: _model, configPath: _config, pitchSemitones: _pitch, ...voice }) => voice), ...(setupError ? { setupError } : {}) };
}
export async function requireVoice(id: string): Promise<VoiceDefinition> {
  const voices = await loadVoiceCatalog(storyConfig.voicesDir); const voice = voices.find(v => v.id === id && v.installed);
  if (!voice) throw new StoryRequestError('PIPER_SETUP_REQUIRED', 'Install the selected Piper voice and its configuration. See Story Narrator setup in README.', 503);
  return voice;
}
