import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server/app.js';
import { JobStore } from '../src/server/store.js';
import type { Job } from '../src/shared/types.js';

test('API rejects foreign origins, unavailable job IDs, remote imports and render before analysis', async t => {
  const { app } = await createApp(path.resolve('test-artifacts', `api-${randomUUID()}`));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const addr = server.address(); assert.ok(addr && typeof addr !== 'string'); const base = `http://127.0.0.1:${addr.port}`;
  assert.equal((await fetch(`${base}/api/jobs`, { headers: { Origin: 'https://evil.test' } })).status, 403);
  assert.equal((await fetch(`${base}/api/jobs/${randomUUID()}`)).status, 404);
  assert.equal((await fetch(`${base}/api/missing`)).status, 404);
  assert.equal((await fetch(`${base}/api/jobs/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://127.0.0.1/secret', permission: true }) })).status, 400);
  const f = new FormData(); f.append('permission', 'true'); f.append('media', new Blob(['not mp4']), 'fake.mp4');
  assert.equal((await fetch(`${base}/api/jobs/upload`, { method: 'POST', body: f })).status, 400);
});
test('persistent store marks interrupted analysis retryable after restart', async () => {
  const root = path.resolve('test-artifacts', `restart-${randomUUID()}`); const store = new JobStore(root); await store.init();
  const id = randomUUID();
  const job: Job = { id, name: 'recording.mp4', createdAt: new Date().toISOString(), status: 'analyzing', stage: 'Transcribing', progress: 15, media: { duration: 300, width: 640, height: 360, hasAudio: true }, mediaHash: 'hash', source: 'upload', vodId: null, vodOffset: 0, highlights: [], outputs: [], warnings: [], error: null, renderOptions: null };
  await store.save(job); const restarted = new JobStore(root); await restarted.init();
  assert.equal(restarted.get(id).status, 'error'); assert.match(restarted.get(id).error!, /restarted/);
  assert.throws(() => restarted.dir('../../escape'));
});
