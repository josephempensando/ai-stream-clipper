import path from 'node:path';
import { mkdir, writeFile, stat, rename, rm } from 'node:fs/promises';
import type { StorySettings } from '../../shared/story.js';
import { StoryRequestError } from '../../shared/story.js';
import { runProcess } from '../process.js';
import { ffmpeg } from '../media.js';
import { storyConfig } from './config.js';
import type { VoiceDefinition } from './voices.js';
import { splitStory, type StoryChunk } from './chunks.js';
import { probeAudio } from './audio.js';
interface PiperInput { textFile: string; wavFile: string; voice: VoiceDefinition; speed: number }
export function piperArgs(input: PiperInput): string[] {
  return ['-m', 'piper', '--model', input.voice.modelPath, '--config', input.voice.configPath, '--input-file', input.textFile, '--output-file', input.wavFile, '--length-scale', String(1 / input.speed), '--sentence-silence', '0.12'];
}
export class PiperSynthesizer {
  constructor(private readonly command: { executable: string; prefix: string[] } = { executable: storyConfig.python, prefix: ['-m', 'piper'] }) {}
  async synthesize(input: PiperInput, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    try {
      await runProcess(this.command.executable, [...this.command.prefix, ...piperArgs(input).slice(2)], { signal, timeout: storyConfig.timeout });
      if (!(await stat(input.wavFile)).size) throw new Error('Empty audio output.');
      const audio = await probeAudio(input.wavFile, signal);
      if (input.voice.pitchSemitones) {
        const raisedRate = Math.round(audio.sampleRate * 2 ** (input.voice.pitchSemitones / 12));
        const pitched = input.wavFile + '.pitch.wav';
        try {
          await ffmpeg(['-i', input.wavFile, '-af', `asetrate=${raisedRate},aresample=${audio.sampleRate},atempo=${audio.sampleRate / raisedRate}`, '-c:a', 'pcm_s16le', pitched], undefined, signal);
          await probeAudio(pitched, signal); signal.throwIfAborted();
          await rename(pitched, input.wavFile);
        } finally { await rm(pitched, { force: true }); }
      }
    } catch (error) {
      signal.throwIfAborted();
      throw new StoryRequestError('PIPER_FAILED', 'Local Piper narration failed. Check the installed model and Python runtime, then retry.', 503);
    }
  }
}
export type NarrationChunk = StoryChunk & { wavFile: string; duration: number; offset: number };
export interface NarrationResult { wavFile: string; duration: number; chunks: NarrationChunk[] }
export async function synthesizeNarration(settings: StorySettings, voice: VoiceDefinition, workDir: string, signal: AbortSignal, onProgress: (completed: number, total: number) => Promise<void>): Promise<NarrationResult> {
  await mkdir(workDir, { recursive: true });
  const source = splitStory(settings.script, storyConfig.chunkCharacters); const chunks: NarrationChunk[] = []; let offset = 0;
  const piper = new PiperSynthesizer();
  for (const chunk of source) {
    signal.throwIfAborted();
    const textFile = path.join(workDir, `speech-${chunk.index}.txt`); const raw = path.join(workDir, `raw-${chunk.index}.wav`); const wavFile = path.join(workDir, `speech-${chunk.index}.wav`);
    await writeFile(textFile, chunk.text.replace(/\s+/g, ' '), 'utf8');
    await piper.synthesize({ textFile, wavFile: raw, voice, speed: settings.speed }, signal);
    // Piper supplies 120 ms sentence silence. Extend paragraph boundaries to 280 ms.
    const pause = chunk.paragraphEnd && chunk.index < source.length - 1 ? ',apad=pad_dur=0.16' : '';
    await ffmpeg(['-i', raw, '-vn', '-ac', '1', '-ar', '48000', '-af', `aresample=48000${pause}`, '-c:a', 'pcm_s16le', wavFile], undefined, signal);
    const { duration } = await probeAudio(wavFile, signal);
    chunks.push({ ...chunk, wavFile, duration, offset }); offset += duration;
    await onProgress(chunks.length, source.length);
  }
  if (!chunks.length) throw new StoryRequestError('EMPTY_SCRIPT', 'Enter a story first.');
  // Only generated basenames enter the concat manifest.
  const manifest = path.join(workDir, 'speech-concat.txt');
  await writeFile(manifest, chunks.map(c => `file 'speech-${c.index}.wav'`).join('\n'));
  const wavFile = path.join(workDir, 'narration.wav');
  await ffmpeg(['-f', 'concat', '-safe', '1', '-i', manifest, '-c:a', 'pcm_s16le', wavFile], undefined, signal);
  return { wavFile, duration: (await probeAudio(wavFile, signal)).duration, chunks };
}
