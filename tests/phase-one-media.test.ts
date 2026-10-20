import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { ffmpeg, probe } from '../src/server/media.js';
import { createApp } from '../src/server/app.js';
import { JobManager } from '../src/server/jobs.js';
import { JobStore, readJson } from '../src/server/store.js';
import { config } from '../src/server/config.js';
import { runProcess } from '../src/server/process.js';
import type { Job } from '../src/shared/types.js';

test('Phase 1: private analysis with unknown rights, cached no-highlight decisions and real synchronized MP4 draft', { timeout: 120_000 }, async t => {
  const root = path.resolve('test-artifacts', `phase-one-${randomUUID()}`); await mkdir(root, { recursive: true });
  const source = path.join(root, 'owned-generated.mp4');
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=5:d=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=30', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', source]);
  const store = new JobStore(root); let rankCalls = 0; let transcribeCalls = 0;
  const manager = new JobManager(store, {
    transcribe: async () => { transcribeCalls++; return Array.from({ length: 3 }, (_, i) => ({ start: i * 10, end: i * 10 + 10, text: `Original fixture sentence ${i}.` })); },
    rank: async (candidates, _images, settings) => {
      rankCalls++; assert.equal(settings?.durationMode, 'auto');
      return candidates.filter(c => c.cues?.[0]?.start === 0).map(c => ({ ...c, start: 0, end: 30, score: 90, title: 'Fixture story', explanation: 'Explicit model double; not an actual inference.' }));
    },
  });
  const { app } = await createApp(root, manager); const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`;
  const form = new FormData(); form.append('permission', 'true'); form.append('media', new Blob([await readFile(source)], { type: 'video/mp4' }), 'owned-generated.mp4');
  const uploaded = await fetch(`${base}/api/jobs/upload`, { method: 'POST', body: form }); assert.equal(uploaded.status, 201);
  const job = await uploaded.json() as Job; assert.equal(job.rights?.category, 'unknown'); assert.equal(job.durationMode, 'auto'); assert.equal(job.clipCount, 5);
  const originalDefault = config.clipCount;
  try {
    config.clipCount = 7;
    const defaultResponse = await fetch(`${base}/api/jobs/upload`, { method: 'POST', body: form });
    assert.equal(defaultResponse.status, 201); assert.equal((await defaultResponse.json()).clipCount, 7);
    form.set('clipCount', 'all');
    const explicitResponse = await fetch(`${base}/api/jobs/upload`, { method: 'POST', body: form });
    assert.equal(explicitResponse.status, 201); assert.equal((await explicitResponse.json()).clipCount, 8);
  } finally { config.clipCount = originalDefault; }
  for (const body of [{ durationMode: 'fixed' }, { clipCount: 0 }, { clipCount: 1.5 }, { minEngagementScore: 101 }, { minEngagementScore: -1 }]) {
    assert.equal((await fetch(`${base}/api/jobs/${job.id}/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 400);
  }
  await manager.analyze(job.id); await manager.idle();
  assert.equal(store.get(job.id).status, 'review', store.get(job.id).error || '');
  assert.deepEqual(store.get(job.id).highlights.map(h => [h.start, h.end]), [[0, 30]]);
  const calls = rankCalls; await manager.analyze(job.id); await manager.idle(); assert.equal(rankCalls, calls); assert.equal(transcribeCalls, 1);
  // A lost ranking cache must not turn a previous result into a cached rejection.
  const cacheName = (await readdir(path.join(root, 'cache')))[0]!;
  const decisions = await readJson<{ rankings: unknown[]; reviewed: string[] }>(path.join(root, 'cache', cacheName, `shortlist-v2-min-30-budget-${config.highlightContextBudget}-silence-${config.maxHighlightSilenceSeconds}`, 'ranking-0.json'));
  assert.equal(decisions?.rankings.length, 1); assert.equal(decisions?.reviewed.length, 3);
  await manager.render(job.id, [{ id: store.get(job.id).highlights[0]!.id, start: 0, end: 30 }], { layout: 'crop', cropX: 0.5, subtitles: true }); await manager.idle();
  assert.equal(store.get(job.id).status, 'complete', store.get(job.id).error || '');
  const target = path.join(store.dir(job.id), 'exports', 'clip-01.mp4'); const media = await probe(target);
  assert.equal(media.width, 1080); assert.equal(media.height, 1920); assert.equal(media.hasAudio, true); assert.ok(Math.abs(media.duration - 30) < 0.15);
  const streams = JSON.parse(await runProcess(config.ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_name,start_time,duration', '-of', 'json', target])).streams as { codec_name: string; start_time: string; duration: string }[];
  assert.deepEqual(streams.map(s => s.codec_name), ['h264', 'aac']);
  assert.ok(streams.every(s => Math.abs(Number(s.start_time)) < 0.08));
  assert.ok(Math.abs(Number(streams[0]!.duration) - Number(streams[1]!.duration)) < 0.15);
  const manifest = await (await fetch(`${base}/api/jobs/${job.id}/results`)).json();
  assert.equal(manifest.purpose, 'draft'); assert.equal(manifest.rights.category, 'unknown'); assert.equal(manifest.rightsAssessment.automatedPublishingAllowed, false);
});
