import path from 'node:path';
import { Semaphore } from './process.js';
import { analyzeRecording, localAdapters } from './pipeline.js';
import type { PipelineAdapters } from './pipeline.js';
import { JobStore, readJson, writeJson } from './store.js';
import { prepareRetention, renderClips } from './render.js';
import type { ClipEdit, Evidence, Job, RenderOptions, Transcript } from '../shared/types.js';
import type { RetentionSettings } from '../shared/retention.js';
import { analyzeNarrative, buildEdl } from './retention.js';
import { transcriptSupports } from './transcripts.js';
import { highlightDetails } from '../shared/highlights.js';
import { sampleFrame } from './media.js';
import { validateEdits, analysisSettingsSchema } from '../shared/validation.js';
import { config } from './config.js';

export class JobManager {
  private readonly queue = new Semaphore(1);
  private readonly pending = new Set<Promise<void>>();
  private readonly reserved = new Set<string>();
  constructor(readonly store: JobStore, private readonly adapters: PipelineAdapters = localAdapters) {}
  private async progress(job: Job, stage: string, percent: number): Promise<void> {
    job.stage = stage; job.progress = percent; await this.store.save(job);
  }
  private schedule(job: Job, work: () => Promise<void>): void {
    const task = this.queue.run(work).catch(async error => {
      job.status = 'error'; job.error = error instanceof Error ? error.message : 'Processing failed.'; job.stage = 'Needs attention'; await this.store.save(job);
    });
    this.pending.add(task);
    void task.finally(() => { this.pending.delete(task); this.reserved.delete(job.id); }).catch(() => {});
  }
  private reserve(job: Job): void {
    if (this.reserved.has(job.id) || ['queued', 'analyzing', 'rendering'].includes(job.status)) throw new Error('Job is already processing.');
    if (this.reserved.size >= 20) throw new Error('Job queue is full. Wait for current work to finish.');
    this.reserved.add(job.id);
  }
  async analyze(id: string, settings: { durationMode?: 'auto'; clipCount?: number | 'all' | undefined; minEngagementScore?: number | undefined; retention?: RetentionSettings | undefined } = {}): Promise<Job> {
    const job = this.store.get(id);
    const options = analysisSettingsSchema.parse({ durationMode: 'auto', clipCount: job.clipCount ?? config.clipCount, minEngagementScore: job.minEngagementScore ?? config.minEngagementScore ?? 70, ...settings });
    this.reserve(job); const previous = { ...job };
    job.durationMode = 'auto'; job.clipCount = options.clipCount; job.minEngagementScore = options.minEngagementScore ?? config.minEngagementScore ?? 70;
    job.selectionVersion = 2;
    if (options.retention) job.retentionSettings = options.retention;
    delete job.highlightPolicy;
    job.status = 'queued'; job.error = null; job.progress = 0; job.outputs = []; job.clipEdits = [];
    try { await this.progress(job, 'Waiting for analysis', 0); }
    catch (error) { this.reserved.delete(job.id); Object.assign(job, previous); throw error; }
    this.schedule(job, async () => {
      job.status = 'analyzing'; await this.progress(job, 'Preparing recording', 5);
      const result = await analyzeRecording(job, this.store.mediaPath(id), this.store.root, (s, p) => this.progress(job, s, p), this.adapters);
      job.highlights = result.highlights; job.warnings = result.warnings;
      await writeJson(path.join(this.store.dir(id), 'transcript.json'), result.transcript);
      await writeJson(path.join(this.store.dir(id), 'evidence.json'), result.evidence);
      if (job.retentionSettings?.autoEdit) await this.retentionPass(job, job.retentionSettings, result.evidence);
      await writeJson(path.join(this.store.dir(id), 'analysis.json'), { highlights: result.highlights, warnings: result.warnings });
      job.status = 'review'; await this.progress(job, 'Ready for review', 100);
    });
    return job;
  }
  private async retentionPass(job: Job, settings: RetentionSettings, evidence: Evidence[]): Promise<void> {
    for (const [index, h] of job.highlights.entries()) {
      await this.progress(job, `Analyzing hook and narrative ${index + 1} of ${job.highlights.length}`, 80 + index / job.highlights.length * 18);
      const frames = [];
      if (config.vision) for (const time of [...new Set([h.start, Math.min(h.start + 1.5, h.end - 0.01), Math.min(h.start + 3, h.end - 0.01)])]) {
        frames.push({ time, image: await sampleFrame(this.store.mediaPath(job.id), time, path.join(this.store.dir(job.id), 'retention-frames', `${index}-${time}.jpg`)) });
      }
      const narrative = await analyzeNarrative(h, settings.hookStrategy, frames);
      // Default to natural when a requested loop is not supported; the render
      // still rejects an explicit unsupported loop until the creator changes it.
      const edl = buildEdl(h, narrative, evidence, { ...settings, ending: settings.ending === 'loop' && !narrative.loop ? 'natural' : settings.ending });
      h.retention = { narrative, edl };
      if (!narrative.coherent) job.warnings.push(`${h.title}: incomplete hook/payoff; ranked below coherent narratives. ${narrative.reason}`);
      if (!(h.cues || []).some(c => c.words?.length)) job.warnings.push(`${h.title}: cached transcript has no word timings; captions will remain plain. Re-transcription is required for karaoke.`);
    }
    job.highlights.sort((a, b) => Number(b.retention?.narrative.coherent || false) - Number(a.retention?.narrative.coherent || false) || b.score - a.score);
    await writeJson(path.join(this.store.dir(job.id), 'analysis.json'), { highlights: job.highlights, warnings: job.warnings });
  }
  async regenerate(id: string, settings: RetentionSettings, edits?: ClipEdit[]): Promise<Job> {
    const job = this.store.get(id);
    if (!job.highlights.length) throw new Error('Analyze the recording before regenerating retention edits.');
    const transcript = await readJson<Transcript>(path.join(this.store.dir(id), 'transcript.json'));
    if (!transcript) throw new Error('Transcript missing. Retry analysis.');
    if (edits) {
      validateEdits(edits, job.media.duration);
      if (edits.some(e => !job.highlights.some(h => h.id === e.id) || !transcriptSupports(transcript.segments, e.start, e.end, job.media.duration, config.maxHighlightSilenceSeconds))) throw new Error('Retention boundaries must match complete source transcript cues. Keep the full question and answer.');
    }
    this.reserve(job); const previous = { ...job };
    job.retentionSettings = settings; job.status = 'queued'; job.outputs = []; job.error = null;
    try { await this.progress(job, 'Waiting for narrative analysis', 0); }
    catch (error) { this.reserved.delete(id); Object.assign(job, previous); throw error; }
    this.schedule(job, async () => {
      job.status = 'analyzing';
      if (edits) job.highlights = job.highlights.map(h => {
        const edit = edits.find(e => e.id === h.id); if (!edit) return h;
        const cues = transcript.segments.filter(c => c.start >= edit.start && c.end <= edit.end);
        const updated = highlightDetails({ ...h, start: edit.start, end: edit.end, cues, transcript: cues.map(c => c.text).join(' ') }); delete updated.retention; return updated;
      });
      if (edits) job.clipEdits = edits;
      const evidence = await readJson<Evidence[]>(path.join(this.store.dir(id), 'evidence.json')) || [];
      await this.retentionPass(job, settings, evidence);
      job.status = 'review'; await this.progress(job, 'Retention edits ready for review', 100);
    });
    return job;
  }
  async render(id: string, edits: ClipEdit[], options: RenderOptions): Promise<Job> {
    const job = this.store.get(id);
    if (!['review', 'complete', 'error'].includes(job.status) || !job.highlights.length) throw new Error('Analyze this recording before rendering.');
    validateEdits(edits, job.media.duration);
    if (edits.some(e => !job.highlights.some(h => h.id === e.id))) throw new Error('Unknown highlight ID.');
    this.reserve(job); const previous = { ...job };
    job.status = 'rendering'; job.outputs = []; job.error = null; job.renderOptions = options;
    job.clipEdits = edits;
    if (options.retention) job.retentionSettings = options.retention;
    let transcript: Transcript;
    try {
      const data = await readJson<Transcript>(path.join(this.store.dir(id), 'transcript.json'));
      if (!data) throw new Error('Transcript missing. Retry analysis.');
      transcript = data; await this.progress(job, 'Waiting to render', 0);
      if (options.retention) for (const edit of edits) prepareRetention(job, edit, options, transcript);
    } catch (error) { this.reserved.delete(job.id); Object.assign(job, previous); throw error; }
    this.schedule(job, async () => {
      job.outputs = await renderClips(job, this.store.mediaPath(id), path.join(this.store.dir(id), 'exports'), edits, options, transcript, (s, p) => this.progress(job, s, p));
      job.status = 'complete'; await this.progress(job, 'Exports ready', 100);
    });
    return job;
  }
  async idle(): Promise<void> { await Promise.all([...this.pending]); }
}
