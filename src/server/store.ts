import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Job } from '../shared/types.js';
import { setTimeout as delay } from 'node:timers/promises';

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
export async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex');
}
export class JobStore {
  readonly jobs = new Map<string, Job>();
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
      this.jobs.set(id, job);
      if (['queued', 'analyzing', 'rendering'].includes(job.status)) {
        job.status = 'error'; job.error = 'Server restarted during processing. Retry analysis or rendering; cached work is retained.';
        await this.save(job);
      }
    }
  }
  async save(job: Job): Promise<void> { this.jobs.set(job.id, job); await writeJson(path.join(this.dir(job.id), 'job.json'), job); }
  get(id: string): Job { const job = this.jobs.get(id); if (!job) throw new Error('Job not found.'); return job; }
}
