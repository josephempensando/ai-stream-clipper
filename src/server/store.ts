import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Job } from '../shared/types.js';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeRights } from '../shared/rights.js';
import type { SourceRights } from '../shared/rights.js';
import { highlightDetails } from '../shared/highlights.js';
import { config } from './config.js';
import { analysisSettingsSchema } from '../shared/validation.js';
import { meetsMinimumDuration } from '../shared/duration.js';

export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`; await writeFile(tmp, JSON.stringify(value, null, 2));
  for (let attempt = 0; ; attempt++) {
    try { await rename(tmp, file); break; }
    catch (error) {
      // Windows scanners/readers can briefly lock an existing cache file.
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 3 || !['EPERM', 'EBUSY', 'EACCES'].includes(code || '')) throw error;
      await delay(50 * 2 ** attempt);
    }
  }
}
export async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T; } catch { return null; }
}
export async function hashFile(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(file, { ...(signal ? { signal } : {}) })) hash.update(chunk); return hash.digest('hex');
}
export class JobStore {
  readonly jobs = new Map<string, Job>();
  private readonly writes = new Map<string, Promise<void>>();
  constructor(readonly root: string) {}
  dir(id: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid job ID.');
    return path.join(this.root, 'jobs', id);
  }
  mediaPath(id: string): string { return path.join(this.dir(id), 'source.mp4'); }
  async init(): Promise<void> {
    await mkdir(path.join(this.root, 'jobs'), { recursive: true });
    await mkdir(path.join(this.root, 'uploads'), { recursive: true });
    for (const id of await readdir(path.join(this.root, 'jobs'))) {
      if (!/^[0-9a-f-]{36}$/.test(id)) continue;
      const job = await readJson<Job>(path.join(this.dir(id), 'job.json'));
      if (!job) continue;
      job.rights = normalizeRights(job.rights);
      job.durationMode = 'auto';
      // Retire unlimited jobs while preserving valid saved numeric preferences.
      const count = analysisSettingsSchema.shape.clipCount.safeParse(job.clipCount ?? config.clipCount);
      const quality = analysisSettingsSchema.shape.minEngagementScore.safeParse(job.minEngagementScore ?? config.minEngagementScore ?? 70);
      job.clipCount = count.success ? count.data : config.clipCount;
      job.selectionVersion = 3;
      job.minEngagementScore = quality.success ? quality.data ?? 70 : config.minEngagementScore ?? 70;
      delete job.highlightPolicy;
      const valid = job.highlights.filter(h => meetsMinimumDuration(h.end - h.start));
      if (valid.length !== job.highlights.length) job.warnings.push('Saved highlights below 30 seconds were excluded. Analyze again to find complete narratives with meaningful context; no filler was added.');
      job.highlights = valid.map(highlightDetails);
      if (job.clipEdits) job.clipEdits = job.clipEdits.filter(e => valid.some(h => h.id === e.id) && meetsMinimumDuration(e.end - e.start));
      this.jobs.set(id, job);
      if (['queued', 'analyzing', 'rendering'].includes(job.status)) {
        job.status = 'error'; job.error = 'Server restarted during processing. Retry analysis or rendering; cached work is retained.';
        await this.save(job);
      }
    }
  }
  private async serialize(id: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.writes.get(id) || Promise.resolve();
    const task = previous.catch(() => {}).then(operation); this.writes.set(id, task);
    try { await task; } finally { if (this.writes.get(id) === task) this.writes.delete(id); }
  }
  async save(job: Job): Promise<void> {
    this.jobs.set(job.id, job);
    await this.serialize(job.id, () => writeJson(path.join(this.dir(job.id), 'job.json'), job));
  }
  async saveRights(id: string, rights: SourceRights): Promise<void> {
    await this.serialize(id, async () => {
      const job = this.get(id); const previous = job.rights; job.rights = rights;
      try { await writeJson(path.join(this.dir(id), 'job.json'), job); }
      catch (error) { if (previous) job.rights = previous; else delete job.rights; throw error; }
    });
  }
  get(id: string): Job { const job = this.jobs.get(id); if (!job) throw new Error('Job not found.'); return job; }
}
