import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server/app.js';
import { ffmpeg, probe } from '../src/server/media.js';
import { hashFile } from '../src/server/store.js';
import { config } from '../src/server/config.js';
import type { Job } from '../src/shared/types.js';

async function fixture(t: test.TestContext, seconds: number) {
  const root = path.resolve('test-artifacts', `mpegts-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const file = path.join(root, 'transport-stream.mp4');
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=5', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-f', 'mpegts', file]);
  const services = await createApp(path.join(root, 'app'));
  const server = services.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const form = new FormData(); form.append('permission', 'true'); form.append('media', new Blob([await readFile(file)], { type: 'video/mp4' }), 'my-recording.mp4');
  return { ...services, file, root: path.join(root, 'app'), form, base: `http://127.0.0.1:${address.port}` };
}

test('upload remuxes MPEG-TS named .mp4 into a real MP4 with video and audio', async t => {
  const f = await fixture(t, 31); const originalHash = await hashFile(f.file);
  const response = await fetch(`${f.base}/api/jobs/upload`, { method: 'POST', body: f.form });
  const data = await response.json() as Job & { error?: string };
  assert.equal(response.status, 201, data.error);
  const media = await probe(f.store.mediaPath(data.id));
  assert.equal(media.width, 160); assert.equal(media.height, 90); assert.equal(media.hasAudio, true);
  assert.ok(Math.abs(media.duration - 31) < 0.2);
  assert.ok(data.warnings.some(w => /MPEG-TS.*MP4/i.test(w)));
  assert.equal(await hashFile(f.file), originalHash);
  assert.deepEqual(await readdir(path.join(f.root, 'uploads')), []);
  const preview = await fetch(`${f.base}/api/jobs/${data.id}/media`, { headers: { Range: 'bytes=0-99' } });
  assert.equal(preview.status, 206); assert.match(preview.headers.get('Content-Type') || '', /video\/mp4/);
});

test('short MPEG-TS recordings are accepted without a fixed clip-duration minimum', async t => {
  const f = await fixture(t, 3);
  const response = await fetch(`${f.base}/api/jobs/upload`, { method: 'POST', body: f.form });
  assert.equal(response.status, 201);
  const job = await response.json() as Job;
  assert.ok(Math.abs(job.media.duration - 3) < 0.2);
  assert.deepEqual(await readdir(path.join(f.root, 'uploads')), []);
});

test('failed remux removes both incoming and remuxed temporary files', async t => {
  const f = await fixture(t, 3);
  const original = config.ffmpeg; config.ffmpeg = path.join(f.root, 'missing-ffmpeg.exe');
  t.after(() => { config.ffmpeg = original; });
  const response = await fetch(`${f.base}/api/jobs/upload`, { method: 'POST', body: f.form });
  assert.equal(response.status, 400);
  assert.match((await response.json() as { error: string }).error, /repackag|MP4/i);
  assert.deepEqual(await readdir(path.join(f.root, 'uploads')), []);
  assert.equal(f.store.jobs.size, 0);
});
