import path from 'node:path';
import { mkdir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { StoryJob, StorySettings, StorySummary } from '../../shared/story.js';
import { StoryRequestError } from '../../shared/story.js';
import { Semaphore } from '../process.js';
import { StoryStore, type StoryRecord, type StoredStoryAsset } from './store.js';
import { runStoryAttempt } from './pipeline.js';
export interface RetainedStoryInput { file: string; originalName: string; hash: string; duration: number; hasAudio: boolean; width?: number; height?: number }
type Runner = typeof runStoryAttempt;
interface AttemptState { controller: AbortController; task: Promise<void>; finish: () => void }
export class StoryJobManager {
  private readonly queue = new Semaphore(1);
  private readonly active = new Map<string, AttemptState>();
  private reservations = 0; private closed = false;
  constructor(readonly store: StoryStore, private readonly runner: Runner = runStoryAttempt) {}
  private reserve(id: string): AttemptState {
    if (this.closed) throw new StoryRequestError('STORY_CLOSED', 'Story processing is shutting down.', 503);
    if (this.active.has(id)) throw new StoryRequestError('STORY_BUSY', 'This story is already processing.', 409);
    if (this.reservations >= 20) throw new StoryRequestError('STORY_QUEUE_FULL', 'The story queue is full. Try again later.', 429);
    let finish!: () => void; const task = new Promise<void>(resolve => { finish = resolve; });
    const state = { controller: new AbortController(), task, finish }; this.active.set(id, state); this.reservations++; return state;
  }
  private release(id: string) { if (this.active.delete(id)) this.reservations--; }
  get(id: string): StoryJob {
    const { input: _input, artifacts: _artifacts, ...job } = this.store.get(id);
    const base = `/api/story-videos/${id}`;
    return structuredClone({ ...job, ...(job.successfulAttemptId ? { previewUrl: `${base}/preview`, downloadUrl: `${base}/download`, ...(_artifacts?.captionsFile ? { captionsUrl: `${base}/captions` } : {}) } : {}) });
  }
  list(): StorySummary[] { return this.store.list().map(job => ({ id: job.id, title: job.settings.script.trim().slice(0, 80), createdAt: job.createdAt, status: job.status, ...(job.actualDuration ? { actualDuration: job.actualDuration } : {}), hasOutput: !!job.successfulAttemptId })); }
  async create(inputs: { video: RetainedStoryInput; music?: RetainedStoryInput }, settings: StorySettings, signal?: AbortSignal): Promise<StoryJob> {
    const id = randomUUID(); const state = this.reserve(id);
    const abort = () => state.controller.abort(signal?.reason); signal?.addEventListener('abort', abort, { once: true });
    try {
      signal?.throwIfAborted();
      const directory = path.join(this.store.dir(id), 'inputs'); await mkdir(directory, { recursive: true }); await this.store.assertOwned(directory);
      const retain = async (source: RetainedStoryInput, filename: string): Promise<StoredStoryAsset> => { signal?.throwIfAborted(); const { file, ...asset } = source; await rename(file, path.join(directory, filename)); signal?.throwIfAborted(); return { ...asset, filename }; };
      const video = await retain(inputs.video, 'background.mp4'); const music = inputs.music ? await retain(inputs.music, 'music.bin') : undefined;
      const now = new Date().toISOString();
      const record: StoryRecord = { id, attemptId: randomUUID(), createdAt: now, updatedAt: now, settings, backgroundName: video.originalName, ...(music ? { musicName: music.originalName } : {}), input: { video, ...(music ? { music } : {}) }, status: 'queued', progress: { stage: 'Queued', percent: 0, completed: 0, total: 1 }, warnings: [], error: null };
      record.attemptId = await this.store.createAttempt(record); signal?.throwIfAborted(); await this.store.save(record); signal?.throwIfAborted(); this.launch(record, state); return this.get(id);
    } catch (error) {
      this.store.records.delete(id);
      try { await this.store.assertOwned(this.store.dir(id)); await rm(this.store.dir(id), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch (cleanupError) { if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanupError; }
      finally { this.release(id); state.finish(); }
      throw error;
    } finally { signal?.removeEventListener('abort', abort); }
  }
  async regenerate(id: string, settings: StorySettings): Promise<StoryJob> {
    const record = this.store.get(id);
    if (record.input.music && !settings.rights.music?.permission) throw new StoryRequestError('MUSIC_PERMISSION_REQUIRED', 'Confirm permission and provenance for the retained music.');
    const state = this.reserve(id);
    try { record.attemptId = await this.store.createAttempt(record); record.settings = settings; record.status = 'queued'; record.error = null; record.warnings = []; record.progress = { stage: 'Queued', percent: 0, completed: 0, total: 1 }; await this.store.save(record); this.launch(record, state); return this.get(id); }
    catch (error) { this.release(id); state.finish(); throw error; }
  }
  private launch(record: StoryRecord, state: AttemptState): void {
    const attempt = record.attemptId; const signal = state.controller.signal;
    void (async () => {
      try {
        await this.queue.run(async () => {
          const artifacts = await this.runner(record, path.join(this.store.attemptDir(record.id, attempt), 'work'), signal, async progress => {
            signal.throwIfAborted(); record.progress = progress; record.status = progress.percent < 30 ? 'synthesizing' : progress.percent < 55 ? 'aligning' : 'rendering'; record.updatedAt = new Date().toISOString(); await this.store.save(record);
          });
          signal.throwIfAborted(); await this.store.promote(record, artifacts);
        }, signal);
        await this.store.cleanupWork(record.id, attempt);
      } catch (error) {
        if (record.successfulAttemptId === attempt && record.status === 'complete') { record.warnings.push('Video is ready; temporary work cleanup will be retried.'); }
        else {
          record.status = signal.aborted ? 'cancelled' : 'error'; record.error = signal.aborted ? null : error instanceof StoryRequestError ? { code: error.code, message: error.message.replace(/[A-Z]:\\[^\n]*/gi, '[local details omitted]') } : { code: 'STORY_FAILED', message: 'Story processing failed. Check local Piper, Whisper and FFmpeg setup, then regenerate.' };
          try { await this.store.cleanupAttempt(record.id, attempt); } catch { record.warnings.push('Temporary file cleanup will be retried on startup.'); }
        }
        try { await this.store.save(record); } catch { /* startup recovery handles interrupted persistence */ }
      } finally { this.release(record.id); state.finish(); }
    })();
  }
  async cancel(id: string): Promise<StoryJob> {
    const record = this.store.get(id); const state = this.active.get(id);
    if (state && record.status !== 'complete') { record.status = 'cancelling'; state.controller.abort(); await this.store.save(record); if (state.task) await state.task; }
    return this.get(id);
  }
  async idle(): Promise<void> { await Promise.all([...this.active.values()].map(s => s.task)); }
  async close(): Promise<void> { this.closed = true; for (const state of this.active.values()) state.controller.abort(); await this.idle(); }
}
