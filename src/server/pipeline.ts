import { mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { config } from './config.js';
import { readJson, writeJson } from './store.js';
import { extractAudio, detectEvidence, sampleFrame } from './media.js';
import { transcribeChunk, rankBatch, validateNaturalRankings } from './models.js';
import { offsetSegments, buildCandidates, selectBestHighlights } from './analysis.js';
import type { Candidate, Evidence, Highlight, Job, Segment, Transcript } from '../shared/types.js';

export interface PipelineAdapters {
  transcribe: (wav: string, dir: string) => Promise<Segment[]>;
  rank: (candidates: Candidate[], images: string[]) => Promise<Highlight[]>;
}
export const localAdapters: PipelineAdapters = { transcribe: transcribeChunk, rank: (candidates, images) => rankBatch(candidates, images, { chooseRanges: true }) };
export async function analyzeRecording(job: Job, file: string, root: string, progress: (stage: string, percent: number) => Promise<void>, adapters = localAdapters): Promise<{ highlights: Highlight[]; transcript: Transcript; warnings: string[] }> {
  if (!job.media.hasAudio) throw new Error('Recording has no audio track. Full Whisper analysis requires audio.');
  const isLocal = adapters === localAdapters;
  const settings = createHash('sha256').update(JSON.stringify({ version: 2, engine: isLocal ? 'local' : 'test-double', whisper: config.whisperModel, language: config.whisperLanguage, chunk: config.chunkSeconds, ollama: config.ollamaModel, vision: config.vision })).digest('hex').slice(0, 16);
  const cache = path.join(root, 'cache', `${job.mediaHash}-${settings}`); await mkdir(cache, { recursive: true });
  let transcript = await readJson<Transcript>(path.join(cache, 'transcript.json'));
  if (!transcript) {
    const segments: Segment[] = [];
    for (let start = 0; start < job.media.duration; start += config.chunkSeconds) {
      await progress(`Transcribing ${Math.floor(start / 60)}–${Math.ceil(Math.min(start + config.chunkSeconds, job.media.duration) / 60)} min`, 10 + 40 * start / job.media.duration);
      const chunkDir = path.join(cache, `chunk-${start}`); const json = path.join(chunkDir, 'segments.json');
      let absolute = await readJson<Segment[]>(json);
      if (!absolute) {
        await mkdir(chunkDir, { recursive: true }); const wav = path.join(chunkDir, 'audio.wav');
        await extractAudio(file, wav, start, Math.min(config.chunkSeconds, job.media.duration - start));
        absolute = offsetSegments(await adapters.transcribe(wav, chunkDir), start, Math.min(job.media.duration, start + config.chunkSeconds));
        await writeJson(json, absolute); await rm(wav, { force: true });
      }
      segments.push(...absolute);
    }
    transcript = { segments, model: isLocal ? config.whisperModel : 'test-double', language: config.whisperLanguage };
    await writeJson(path.join(cache, 'transcript.json'), transcript);
  }
  await progress('Detecting audio energy and scene changes', 52);
  let evidence = await readJson<Evidence[]>(path.join(cache, 'evidence.json'));
  if (!evidence) { evidence = await detectEvidence(file); await writeJson(path.join(cache, 'evidence.json'), evidence); }
  const candidates = buildCandidates(transcript.segments, evidence, job.media.duration);
  // Invalidate fixed-window rankings while retaining completed transcription.
  const rangeCache = path.join(cache, 'natural-ranges-v1');
  await writeJson(path.join(rangeCache, 'candidates.json'), candidates);
  const ranked: Highlight[] = []; const size = config.vision ? 2 : 3;
  for (let i = 0; i < candidates.length; i += size) {
    const batch = candidates.slice(i, i + size);
    await progress(`Ranking moments ${i + 1}–${i + batch.length} of ${candidates.length}`, 65 + 30 * i / candidates.length);
    const fileName = path.join(rangeCache, `ranking-${i}.json`);
    let rankings = await readJson<Highlight[]>(fileName);
    if (!rankings) {
      const images: string[] = [];
      for (const c of batch) {
        // First frame is always available for review; all three are sent to a vision model.
        for (const time of config.vision ? c.frameTimes : c.frameTimes.slice(0, 1)) {
          const jpeg = await sampleFrame(file, time, path.join(cache, 'frames', `${c.id}-${time}.jpg`));
          if (config.vision) images.push(jpeg);
        }
      }
      rankings = validateNaturalRankings({ rankings: await adapters.rank(batch, images) }, batch);
      await writeJson(fileName, rankings);
    }
    ranked.push(...validateNaturalRankings({ rankings }, batch));
  }
  const highlights = selectBestHighlights(ranked);
  const warnings = [`Heuristic cues include loudness, reaction language and scenes; laughter is not independently classified.`, ...(config.vision ? [] : ['Text model used transcript and scene metadata; sampled frames were not interpreted by a vision model.'])];
  if (!isLocal) warnings.unshift('TEST ONLY: transcription and ranking used injected model doubles; actual Whisper/Ollama inference did not run.');
  if (highlights.length < 5) warnings.push(`Found ${highlights.length} non-overlapping highlights; kept the model-chosen boundaries rather than cutting moments to reach five.`);
  await progress('Highlights ready for review', 100);
  return { highlights, transcript, warnings };
}
