import path from 'node:path';
import { Semaphore } from './process.js';
import { analyzeRecording, localAdapters } from './pipeline.js';
import type { PipelineAdapters } from './pipeline.js';
import { JobStore, readJson, writeJson } from './store.js';
import { renderClips } from './render.js';
import type { ClipEdit, Job, RenderOptions, Transcript } from '../shared/types.js';
import { validateEdits } from '../shared/validation.js';

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
  async analyze(id: string): Promise<Job> {
    const job = this.store.get(id);
    this.reserve(job); const previous = { ...job };
    job.status = 'queued'; job.error = null; job.progress = 0; job.outputs = [];
    try { await this.progress(job, 'Waiting for analysis', 0); }
    catch (error) { this.reserved.delete(job.id); Object.assign(job, previous); throw error; }
    this.schedule(job, async () => {
      job.status = 'analyzing'; await this.progress(job, 'Preparing recording', 5);
      const result = await analyzeRecording(job, this.store.mediaPath(id), this.store.root, (s, p) => this.progress(job, s, p), this.adapters);
      job.highlights = result.highlights; job.warnings = result.warnings;
      await writeJson(path.join(this.store.dir(id), 'transcript.json'), result.transcript);
      await writeJson(path.join(this.store.dir(id), 'analysis.json'), { highlights: result.highlights, warnings: result.warnings });
      job.status = 'review'; await this.progress(job, 'Ready for review', 100);
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
    let transcript: Transcript;
    try {
      const data = await readJson<Transcript>(path.join(this.store.dir(id), 'transcript.json'));
      if (!data) throw new Error('Transcript missing. Retry analysis.');
      transcript = data; await this.progress(job, 'Waiting to render', 0);
    } catch (error) { this.reserved.delete(job.id); Object.assign(job, previous); throw error; }
    this.schedule(job, async () => {
      job.outputs = await renderClips(job, this.store.mediaPath(id), path.join(this.store.dir(id), 'exports'), edits, options, transcript, (s, p) => this.progress(job, s, p));
      job.status = 'complete'; await this.progress(job, 'Exports ready', 100);
    });
    return job;
  }
  async idle(): Promise<void> { await Promise.all([...this.pending]); }
}
