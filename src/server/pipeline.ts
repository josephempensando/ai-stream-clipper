import { mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { config } from './config.js';
import { readJson, writeJson } from './store.js';
import { extractAudio, detectEvidence, sampleFrame } from './media.js';
import { transcribeChunk, rankBatch } from './models.js';
import { offsetSegments, buildCandidates, selectBestHighlights } from './analysis.js';
import { recoverRankings, validateCachedRankings } from './ranking.js';
import { transcriptSupports } from './transcripts.js';
import type { Candidate, Evidence, Highlight, Job, Segment, Transcript } from '../shared/types.js';

export interface PipelineAdapters {
  transcribe: (wav: string, dir: string) => Promise<Segment[]>;
  rank: (candidates: Candidate[], images: string[], settings?: { onWarning: (warning: string) => void; durationMode?: 'auto' }) => Promise<Highlight[]>;
}
export const localAdapters: PipelineAdapters = { transcribe: transcribeChunk, rank: (candidates, images, settings) => rankBatch(candidates, images, { chooseRanges: true, ...settings }) };
export async function analyzeRecording(job: Job, file: string, root: string, progress: (stage: string, percent: number) => Promise<void>, adapters = localAdapters): Promise<{ highlights: Highlight[]; transcript: Transcript; warnings: string[] }> {
  if (!job.media.hasAudio) throw new Error('Recording has no audio track. Full Whisper analysis requires audio.');
  const isLocal = adapters === localAdapters;
  const clipCount = job.clipCount ?? config.clipCount ?? 5;
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
  const rangeCache = path.join(cache, `auto-ranges-v3-silence-${config.maxHighlightSilenceSeconds}`);
  await writeJson(path.join(rangeCache, 'candidates.json'), candidates);
  const ranked: Highlight[] = []; const size = config.vision ? 2 : 3;
  const recoveryWarnings = new Set<string>(); let stopped: Error | null = null; let reviewedCount = 0;
  for (let i = 0; i < candidates.length; i += size) {
    const batch = candidates.slice(i, i + size);
    await progress(`Ranking moments ${i + 1}–${i + batch.length} of ${candidates.length}`, 65 + 30 * i / candidates.length);
    const fileName = path.join(rangeCache, `ranking-${i}.json`);
    const saved = await readJson<unknown>(fileName);
    let reviewed: string[] = [];
    let rankings: Highlight[] = [];
    if (saved && typeof saved === 'object' && 'rankings' in saved && 'reviewed' in saved && Array.isArray(saved.rankings) && Array.isArray(saved.reviewed) && saved.reviewed.every(id => typeof id === 'string' && batch.some(c => c.id === id))) {
      rankings = saved.rankings as Highlight[]; reviewed = [...new Set(saved.reviewed as string[])];
    }
    const persist = () => writeJson(fileName, { rankings, reviewed });
    try { rankings = validateCachedRankings(rankings, batch, true, true); }
    catch { rankings = []; reviewed = []; recoveryWarnings.add('An invalid cached ranking was discarded and analyzed again.'); }
    const missing = batch.filter(c => !reviewed.includes(c.id) && !rankings.some(row => row.id === c.id));
    if (missing.length && !stopped) {
      const images: string[] = [];
      for (const c of missing) {
        // First frame is always available for review; all three are sent to a vision model.
        for (const time of config.vision ? c.frameTimes : c.frameTimes.slice(0, 1)) {
          const jpeg = await sampleFrame(file, time, path.join(cache, 'frames', `${c.id}-${time}.jpg`));
          if (config.vision) images.push(jpeg);
        }
      }
      const recovered = await recoverRankings(missing, images, (cs, frames) => adapters.rank(cs, frames, { durationMode: 'auto', onWarning: warning => recoveryWarnings.add(warning) }), {
        durationMode: 'auto',
        onWarning: warning => recoveryWarnings.add(warning),
        onProgress: stage => progress(stage, 65 + 30 * i / candidates.length),
        onAccepted: async rows => { rankings.push(...rows); await persist(); },
        onReviewed: async ids => { reviewed = [...new Set([...reviewed, ...ids])]; await persist(); },
      });
      stopped = recovered.error;
    }
    ranked.push(...validateCachedRankings(rankings, batch, true, true));
    reviewedCount += new Set([...reviewed, ...rankings.map(h => h.id)]).size;
  }
  if (candidates.length && !ranked.length && !reviewedCount) throw stopped || new Error('Ollama could not return valid highlight timings after smaller requests and retries. Completed transcription is saved. Try analyzing again or choose a more capable local model.');
  // Recheck against the original timeline, independently of reading contexts.
  if (ranked.some(h => !transcriptSupports(transcript.segments, h.start, h.end, job.media.duration, config.maxHighlightSilenceSeconds))) throw new Error('Highlight timing is unsupported by the original recording transcript.');
  const highlights = selectBestHighlights(ranked, clipCount);
  const warnings = [`Heuristic cues include loudness, reaction language and scenes; laughter is not independently classified.`, ...(config.vision ? [] : ['Text model used transcript and scene metadata; sampled frames were not interpreted by a vision model.'])];
  if (!isLocal) warnings.unshift('TEST ONLY: transcription and ranking used injected model doubles; actual Whisper/Ollama inference did not run.');
  warnings.push(...recoveryWarnings);
  if (reviewedCount < candidates.length) warnings.push(`${candidates.length - reviewedCount} reading context(s) could not be analyzed and were skipped. Valid highlights are ready; Analyze again retries missing work using cached transcription and rankings.`);
  if (stopped) warnings.push(stopped.message);
  if (highlights.length < clipCount) warnings.push(`Found ${highlights.length} of ${clipCount} requested non-overlapping highlights; kept supported model-chosen boundaries without padding or inventing moments.`);
  await progress('Highlights ready for review', 100);
  return { highlights, transcript, warnings };
}
