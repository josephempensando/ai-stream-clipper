import path from 'node:path';
import { mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { StoryRequestError, createStorySettingsSchema, storyStatuses } from '../../shared/story.js';
import type { StoryJob } from '../../shared/story.js';
import { readJson, writeJson } from '../store.js';
import { safePath, containedFile, ownedDirectory } from './paths.js';

export interface StoredStoryAsset { filename: string; originalName: string; hash: string; duration: number; hasAudio: boolean; width?: number; height?: number }
export interface StoryArtifacts { attemptId: string; narrationDuration: number; videoDuration: number; videoFile: string; manifestFile: string; captionsFile?: string }
export interface StoryRecord extends StoryJob { input: { video: StoredStoryAsset; music?: StoredStoryAsset }; artifacts?: StoryArtifacts }
const uuid = z.uuid();
const fileNames = new Set(['video.mp4', 'captions.srt', 'captions.ass', 'results.json', 'narration.wav']);
const assetSchema = z.object({ filename: z.enum(['background.mp4', 'music.bin']), originalName: z.string(), hash: z.string(), duration: z.number().positive().finite(), hasAudio: z.boolean(), width: z.number().positive().optional(), height: z.number().positive().optional() }).strict();
const persistedSchema = z.object({ id: uuid, attemptId: uuid, status: z.enum(storyStatuses), settings: createStorySettingsSchema(100_000), input: z.object({ video: assetSchema, music: assetSchema.optional() }), successfulAttemptId: uuid.optional(), artifacts: z.object({ attemptId: uuid, narrationDuration: z.number().positive().finite(), videoDuration: z.number().positive().finite(), videoFile: z.literal('video.mp4'), manifestFile: z.literal('results.json'), captionsFile: z.literal('captions.srt').optional() }).optional() }).passthrough();

export async function resolveStoryArtifact(root: string, jobId: string, attemptId: string, filename: string): Promise<string> {
  if (!uuid.safeParse(jobId).success || !uuid.safeParse(attemptId).success || !fileNames.has(filename)) throw new StoryRequestError('INVALID_ARTIFACT', 'Invalid story artifact.');
  const job = await ownedDirectory(path.join(root, 'story-videos'), jobId);
  const attempt = await ownedDirectory(job, path.join('runs', attemptId));
  return containedFile(attempt, filename);
}
export class StoryStore {
  readonly records = new Map<string, StoryRecord>();
  readonly base: string;
  private readonly writes = new Map<string, Promise<void>>();
  constructor(readonly root: string) { this.base = path.resolve(root, 'story-videos'); }
  dir(id: string): string { if (!uuid.safeParse(id).success) throw new StoryRequestError('INVALID_JOB_ID', 'Invalid story ID.'); return safePath(this.base, id); }
  attemptDir(id: string, attemptId: string): string { if (!uuid.safeParse(attemptId).success) throw new StoryRequestError('INVALID_ATTEMPT', 'Invalid story attempt.'); return safePath(this.dir(id), 'runs', attemptId); }
  async assertOwned(directory: string): Promise<void> { await ownedDirectory(this.base, path.relative(this.base, directory)); }
  async init(): Promise<void> {
    await mkdir(this.base, { recursive: true });
    for (const id of await readdir(this.base)) {
      if (!uuid.safeParse(id).success) continue;
      let job: StoryRecord;
      try {
        const file = await containedFile(this.base, path.join(id, 'job.json'));
        const data = persistedSchema.parse(await readJson<unknown>(file));
        if (data.id !== id) continue;
        job = data as unknown as StoryRecord;
      } catch { continue; }
      this.records.set(id, job);
      if (!['complete', 'error', 'cancelled'].includes(job.status)) {
        job.status = 'error'; job.error = { code: 'STORY_INTERRUPTED', message: 'Server restarted during processing. Regenerate to retry.' };
        try { await this.cleanupAttempt(id, job.attemptId); } catch { job.warnings.push('Interrupted work cleanup will be retried on the next startup.'); }
        await this.save(job);
      } else if (job.status !== 'complete' && job.attemptId !== job.successfulAttemptId) {
        try { await this.cleanupAttempt(id, job.attemptId); } catch { /* retained warning from previous cleanup */ }
      } else if (job.status === 'complete') {
        try { await this.cleanupWork(id, job.attemptId); } catch { job.warnings.push('Temporary work cleanup failed; it will be retried on startup.'); await this.save(job); }
      }
    }
  }
  get(id: string): StoryRecord { this.dir(id); const job = this.records.get(id); if (!job) throw new StoryRequestError('STORY_NOT_FOUND', 'Story job not found.', 404); return job; }
  list(): StoryRecord[] { return [...this.records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  async save(record: StoryRecord): Promise<void> {
    const directory = this.dir(record.id); await mkdir(directory, { recursive: true }); await this.assertOwned(directory);
    this.records.set(record.id, record);
    const previous = this.writes.get(record.id) || Promise.resolve();
    const snapshot = structuredClone(record);
    const task = previous.catch(() => {}).then(() => writeJson(path.join(directory, 'job.json'), snapshot));
    this.writes.set(record.id, task);
    try { await task; } finally { if (this.writes.get(record.id) === task) this.writes.delete(record.id); }
  }
  async createAttempt(record: StoryRecord): Promise<string> {
    const attempt = randomUUID(); await mkdir(path.join(this.attemptDir(record.id, attempt), 'work'), { recursive: true });
    await this.assertOwned(this.attemptDir(record.id, attempt)); return attempt;
  }
  async promote(record: StoryRecord, artifacts: StoryArtifacts): Promise<void> {
    if (record.attemptId !== artifacts.attemptId || record.status === 'cancelling' || record.status === 'cancelled') throw new DOMException('Cancelled.', 'AbortError');
    for (const file of [artifacts.videoFile, artifacts.manifestFile, ...(artifacts.captionsFile ? [artifacts.captionsFile] : [])]) await resolveStoryArtifact(this.root, record.id, artifacts.attemptId, file);
    if ((record.status as string) === 'cancelling' || (record.status as string) === 'cancelled') throw new DOMException('Cancelled.', 'AbortError');
    const previous = structuredClone(record);
    record.artifacts = artifacts; record.successfulAttemptId = artifacts.attemptId; record.actualDuration = artifacts.narrationDuration;
    record.status = 'complete'; record.error = null; record.progress = { stage: 'Video ready', percent: 100, completed: 1, total: 1 }; record.updatedAt = new Date().toISOString();
    try { await this.save(record); }
    catch (error) { for (const key of Object.keys(record)) delete (record as unknown as Record<string, unknown>)[key]; Object.assign(record, previous); throw error; }
  }
  async cleanupAttempt(id: string, attemptId: string): Promise<void> {
    if (this.records.get(id)?.successfulAttemptId === attemptId) return;
    const directory = this.attemptDir(id, attemptId);
    try { await this.assertOwned(directory); await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  async cleanupWork(id: string, attemptId: string): Promise<void> {
    const work = path.join(this.attemptDir(id, attemptId), 'work');
    try { await this.assertOwned(work); await rm(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  async artifactPath(id: string, filename: string): Promise<string> {
    const job = this.get(id); if (!job.successfulAttemptId || !job.artifacts) throw new StoryRequestError('STORY_NOT_READY', 'Generate a successful video first.', 409);
    if (filename === 'captions.srt' && !job.artifacts.captionsFile) throw new StoryRequestError('CAPTIONS_DISABLED', 'This draft has no subtitles.', 409);
    return resolveStoryArtifact(this.root, id, job.successfulAttemptId, filename);
  }
}
