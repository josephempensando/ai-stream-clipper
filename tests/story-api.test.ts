import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server/app.js';
test('story routes are private, validate permission and leave existing jobs available', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'story-api-')); const services = await createApp(root);
  const server = services.app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r)); const address = server.address(); const base = `http://127.0.0.1:${typeof address === 'object' ? address!.port : 0}`;
  try {
    const list = await fetch(base + '/api/story-videos'); assert.equal(list.status, 200); assert.equal(list.headers.get('cache-control'), 'no-store'); assert.deepEqual(await list.json(), []);
    const form = new FormData(); form.append('background', new Blob(['fake mp4']), 'fake.mp4'); form.append('settings', JSON.stringify({ script: 'A story.', voiceId: 'bad', rights: { footagePermission: false } }));
    const invalid = await fetch(base + '/api/story-videos', { method: 'POST', body: form }); assert.equal(invalid.status, 400);
    assert.equal((await fetch(base + '/api/jobs')).status, 200);
    assert.equal((await fetch(base + '/api/story-videos/not-an-id')).status, 400);
    const oversized = await fetch(base + '/api/story-videos/voice-previews', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(140000) }) });
    assert.equal(oversized.status, 413); assert.equal(oversized.headers.get('cache-control'), 'no-store'); assert.equal((await oversized.json() as { code: string }).code, 'UPLOAD_TOO_LARGE');
  } finally { await services.story?.close(); await new Promise<void>(r => server.close(() => r())); await rm(root, { recursive: true, force: true }); }
});
