import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { JobStore, writeJson } from '../src/server/store.js';
import { JobManager } from '../src/server/jobs.js';
import type { Job } from '../src/shared/types.js';

function jobFixture(): Job {
  return { id: randomUUID(), name: 'test.mp4', createdAt: new Date().toISOString(), status: 'review', stage: 'Ready', progress: 100, media: { duration: 300, width: 640, height: 360, hasAudio: false }, mediaHash: 'hash', source: 'upload', vodId: null, vodOffset: 0, highlights: [{ id: 'a', start: 0, end: 45, title: 'Moment', explanation: 'Context', score: 70, heuristicScore: 20, transcript: '', evidence: [], frameTimes: [] }], outputs: [], warnings: [], error: null, renderOptions: null };
}
test('concurrent render submissions reserve the job exactly once before awaiting transcript', async () => {
  const store = new JobStore(path.resolve('test-artifacts', `race-${randomUUID()}`)); await store.init();
  const job = jobFixture(); await store.save(job); await writeJson(path.join(store.dir(job.id), 'transcript.json'), { segments: [], language: 'en', model: 'test' });
  const manager = new JobManager(store);
  const results = await Promise.allSettled(Array.from({ length: 2 }, () => manager.render(job.id, [{ id: 'a', start: 0, end: 30 }], { layout: 'blur', cropX: 0.5, subtitles: false })));
  await manager.idle(); // Missing media intentionally makes the admitted render fail safely.
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
});
test('queue admission is bounded even when many requests arrive before persistence finishes', async () => {
  const store = new JobStore(path.resolve('test-artifacts', `capacity-${randomUUID()}`)); await store.init();
  const jobs = Array.from({ length: 25 }, jobFixture);
  await Promise.all(jobs.map(j => store.save(j)));
  const manager = new JobManager(store);
  const results = await Promise.allSettled(jobs.map(j => manager.analyze(j.id)));
  await manager.idle();
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 20);
  assert.equal(results.filter(r => r.status === 'rejected').length, 5);
});
test('job stays reserved while terminal status is being persisted', async () => {
  const store = new JobStore(path.resolve('test-artifacts', `terminal-${randomUUID()}`)); await store.init();
  const job = jobFixture(); await store.save(job); await writeJson(path.join(store.dir(job.id), 'transcript.json'), { segments: [], language: 'en', model: 'test' });
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const terminalSave = new Promise<void>(resolve => { entered = resolve; });
  const originalSave = store.save.bind(store);
  store.save = async current => { if (current.status === 'error') { entered(); await gate; } await originalSave(current); };
  const manager = new JobManager(store);
  await manager.render(job.id, [{ id: 'a', start: 0, end: 30 }], { layout: 'blur', cropX: 0.5, subtitles: false });
  await terminalSave;
  try { await assert.rejects(manager.analyze(job.id), /already processing/); }
  finally { release(); await manager.idle(); }
});
