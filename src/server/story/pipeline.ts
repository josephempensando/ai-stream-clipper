import path from 'node:path';
import { copyFile, writeFile } from 'node:fs/promises';
import type { StoryProgress } from '../../shared/story.js';
import type { StoryRecord, StoryArtifacts } from './store.js';
import { requireVoice } from './voices.js';
import { synthesizeNarration } from './piper.js';
import { alignNarration } from './alignment.js';
import { writeStoryCaptions } from './captions.js';
import { prepareStoryBackground } from './background.js';
import { renderStory } from './render.js';
import { resolveStoryInputs } from './paths.js';
import { runProcess } from '../process.js';
import { storyConfig } from './config.js';
import { config } from '../config.js';
export interface StoryPipelineAdapters { synthesize: typeof synthesizeNarration; align: typeof alignNarration; writeCaptions: typeof writeStoryCaptions; prepareBackground: typeof prepareStoryBackground; render: typeof renderStory }
const defaults: StoryPipelineAdapters = { synthesize: synthesizeNarration, align: alignNarration, writeCaptions: writeStoryCaptions, prepareBackground: prepareStoryBackground, render: renderStory };
export async function runStoryAttempt(record: StoryRecord, workDir: string, signal: AbortSignal, onProgress: (progress: StoryProgress) => Promise<void>, adapters: StoryPipelineAdapters = defaults): Promise<StoryArtifacts> {
  const outputDirectory = path.dirname(workDir); const inputs = await resolveStoryInputs(path.resolve(outputDirectory, '..', '..'), !!record.input.music);
  const voice = await requireVoice(record.settings.voiceId); signal.throwIfAborted();
  const versions = JSON.parse(await runProcess(storyConfig.python, ['-c', 'import sys,json,importlib.metadata as m; d={x.metadata["Name"].lower():x.version for x in m.distributions()}; print(json.dumps({"python":sys.version.split()[0],"piper":d.get("piper-tts"),"whisper":d.get("openai-whisper")}))'], { signal, timeout: 10_000 }));
  const progress = (stage: string, base: number, span: number) => (completed: number, total: number) => { signal.throwIfAborted(); return onProgress({ stage, percent: base + span * completed / Math.max(1, total), completed, total }); };
  await onProgress({ stage: 'Synthesizing narration', percent: 0, completed: 0, total: 1 });
  const narration = await adapters.synthesize(record.settings, voice, workDir, signal, progress('Synthesizing narration', 0, 30)); signal.throwIfAborted();
  await onProgress({ stage: 'Aligning spoken words', percent: 30, completed: 0, total: narration.chunks.length });
  const alignment = record.settings.subtitles.enabled ? await adapters.align(narration, record.settings, workDir, signal, progress('Aligning spoken words', 30, 25), voice.language) : { segments: [], coverage: 1, warnings: [] };
  signal.throwIfAborted(); record.warnings.push(...alignment.warnings);
  const captions = record.settings.subtitles.enabled ? await adapters.writeCaptions(alignment.segments, narration.duration, record.settings.subtitles, outputDirectory) : undefined;
  await onProgress({ stage: 'Preparing background and audio', percent: 55, completed: 0, total: 1 });
  const background = await adapters.prepareBackground({ ...inputs, duration: narration.duration, settings: record.settings, workDir }, signal); signal.throwIfAborted();
  await onProgress({ stage: 'Encoding video', percent: 55, completed: 0, total: narration.duration });
  const rendered = await adapters.render({ background, narrationFile: narration.wavFile, narrationDuration: narration.duration, ...(captions ? { assFile: captions.assFile } : {}), outputDirectory, settings: record.settings }, signal, seconds => progress('Encoding video', 55, 43)(seconds, narration.duration));
  signal.throwIfAborted(); await onProgress({ stage: 'Validating output', percent: 98, completed: 0, total: 1 });
  await copyFile(narration.wavFile, path.join(outputDirectory, 'narration.wav'));
  await writeFile(path.join(outputDirectory, 'results.json'), JSON.stringify({ schemaVersion: 1, jobId: record.id, attemptId: record.attemptId, script: record.settings.script, settings: record.settings, engines: { ...versions, voice: voice.id, language: voice.language, voiceLicenseUrl: voice.licenseUrl, whisperModel: config.whisperModel, videoCodec: 'h264', audioCodec: 'aac', sampleRate: 48000 }, narrationDuration: narration.duration, videoDuration: rendered.videoDuration, captionCoverage: alignment.coverage, segments: alignment.segments, chunks: narration.chunks.map(({ wavFile: _file, ...chunk }) => chunk), warnings: record.warnings, purpose: 'private-draft' }, null, 2));
  signal.throwIfAborted();
  return { attemptId: record.attemptId, narrationDuration: narration.duration, videoDuration: rendered.videoDuration, videoFile: 'video.mp4', manifestFile: 'results.json', ...(captions ? { captionsFile: 'captions.srt' } : {}) };
}
