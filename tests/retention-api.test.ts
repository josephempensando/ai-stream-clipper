import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { createApp } from '../src/server/app.js';
import { JobStore, writeJson } from '../src/server/store.js';
import { JobManager } from '../src/server/jobs.js';
import { retentionSettingsSchema } from '../src/shared/retention.js';
import { validateNarrative } from '../src/server/retention.js';
import { ffmpeg } from '../src/server/media.js';
import { prepareRetention } from '../src/server/render.js';
import type { Job, Transcript } from '../src/shared/types.js';
import { config } from '../src/server/config.js';
import { analyzeRecording } from '../src/server/pipeline.js';

test('retention API preserves provenance, refuses unapproved audio, validates boundaries and persists real model decisions', { timeout: 30000 }, async t => {
  const root = path.resolve('test-artifacts', `retention-api-${randomUUID()}`); const store = new JobStore(root); await store.init();
  const id = randomUUID(); const settings = retentionSettingsSchema.parse({ autoEdit: true });
  const transcript: Transcript = { model: 'test-fixture', language: 'en', segments: [{ start: 0, end: 2, text: 'Why?', words: [{ start: 0, end: 1, word: 'Why?' }] }, { start: 2, end: 4, text: 'The cable was loose.' }] };
  const job: Job = { id, name: 'Owned fixture.mp4', createdAt: new Date().toISOString(), status: 'review', stage: 'Ready', progress: 100, media: { duration: 4, width: 320, height: 180, hasAudio: true }, mediaHash: 'owned', source: 'upload', vodId: null, vodOffset: 0, outputs: [], warnings: [], error: null, renderOptions: null, highlights: [{ id: 'h', start: 0, end: 4, title: 'Question answered', explanation: 'Test fixture', score: 80, transcript: 'Why? The cable was loose.', cues: transcript.segments, frameTimes: [], heuristicScore: 0, evidence: [] }] };
  await store.save(job); await writeJson(path.join(store.dir(id), 'transcript.json'), transcript);
  const manager = new JobManager(store); const { app } = await createApp(root, manager);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  t.after(() => { server.closeAllConnections(); server.close(); }); const address = server.address(); assert.ok(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}/api/jobs/${id}`;
  const nativeFetch = globalThis.fetch;
  const raw = { hook: { first: 0, last: 0 }, setup: null, escalation: null, payoff: { first: 1, last: 1 }, ending: { first: 1, last: 1 }, reason: 'Question and its source answer.', loop: false, loopReason: 'Ends in a conclusion.', emphasis: [], pauseCuts: [] };
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => String(url).includes('/api/chat') ? Response.json({ message: { content: JSON.stringify(raw) } }) : nativeFetch(url, init));
  const post = (endpoint: string, body: unknown) => fetch(`${base}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('/retention', { settings, clips: [{ id: 'h', start: 0.5, end: 4 }] })).status, 400);
  assert.equal((await post('/retention', { settings, clips: [{ id: 'unknown', start: 0, end: 4 }] })).status, 400);
  assert.equal((await post('/retention', { settings, clips: [{ id: 'h', start: 0, end: 4 }] })).status, 202);
  await manager.idle(); assert.equal(store.get(id).status, 'review');
  assert.equal(store.get(id).highlights[0]?.retention?.narrative.beats.payoff?.quote, 'The cable was loose.');
  assert.equal((await (await fetch(`${base}/transcript`)).json() as Transcript).segments[0]?.words?.[0]?.end, 1);
  assert.throws(() => prepareRetention(job, { id: 'h', start: 0, end: 3 }, { layout: 'blur', cropX: 0.5, subtitles: false, retention: settings }, transcript), /Regenerate/);
  assert.throws(() => prepareRetention(job, { id: 'h', start: 0, end: 4, adjustments: { captions: [{ start: 0.1, end: 1, text: 'Invented timing' }] } }, { layout: 'blur', cropX: 0.5, subtitles: false, retention: settings }, transcript), /original/);
  assert.ok(prepareRetention(job, { id: 'h', start: 0, end: 4 }, { layout: 'blur', cropX: 0.5, subtitles: false, retention: { ...settings, autoEdit: false } }, transcript).edl.actions.some(a => a.type === 'normalize'), 'EDL must document actual normalization even with Auto Edit disabled.');
  const audio = path.join(root, 'owned.wav'); await ffmpeg(['-f', 'lavfi', '-i', 'sine=duration=0.2', audio]); const bytes = await readFile(audio);
  const form = (permission: string) => { const f = new FormData(); f.append('kind', 'music'); f.append('license', 'owned'); f.append('provenance', 'Generated locally with FFmpeg for this test.'); f.append('permission', permission); f.append('audio', new Blob([bytes], { type: 'audio/wav' }), 'owned.wav'); return f; };
  assert.equal((await fetch(`${base}/audio`, { method: 'POST', body: form('false') })).status, 400);
  const approved = await fetch(`${base}/audio`, { method: 'POST', body: form('true') }); assert.equal(approved.status, 201);
  assert.equal(store.get(id).audioAssets?.[0]?.provenance, 'Generated locally with FFmpeg for this test.');
  assert.equal((await fetch(`${base}/preview/source.mp4`)).status, 404);
  // Invalid model evidence becomes a genuine job error; the previous transcript remains usable.
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => String(url).includes('/api/chat') ? Response.json({ message: { content: JSON.stringify({ ...raw, payoff: { first: 99, last: 99 } }) } }) : nativeFetch(url, init));
  await manager.regenerate(id, settings); await manager.idle(); assert.equal(store.get(id).status, 'error'); assert.match(store.get(id).error || '', /unsupported/);
  assert.equal(validateNarrative(raw, job.highlights[0]!).beats.hook?.quote, 'Why?');
});

test('pre-retention segment-only caches upgrade to actual word timestamps on analysis', { timeout: 30000 }, async () => {
  const root = path.resolve('test-artifacts', `retention-cache-${randomUUID()}`); await mkdir(root, { recursive: true });
  const source = path.join(root, 'owned.mp4');
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=5:d=2', '-f', 'lavfi', '-i', 'sine=duration=2', '-c:v', 'libx264', '-c:a', 'aac', source]);
  // Historical on-disk cache key, deliberately independent of the new engine version.
  const oldKey = createHash('sha256').update(JSON.stringify({ version: 2, engine: 'test-double', whisper: config.whisperModel, language: config.whisperLanguage, chunk: config.chunkSeconds, ollama: config.ollamaModel, vision: config.vision })).digest('hex').slice(0, 16);
  await writeJson(path.join(root, 'cache', `owned-${oldKey}`, 'transcript.json'), { segments: [{ start: 0, end: 2, text: 'Legacy segment only.' }], model: 'test-double', language: 'en' });
  const job: Job = { id: randomUUID(), name: 'owned.mp4', mediaHash: 'owned', source: 'upload', vodId: null, vodOffset: 0, createdAt: '', status: 'uploaded', stage: '', progress: 0, media: { duration: 2, width: 160, height: 90, hasAudio: true }, highlights: [], outputs: [], warnings: [], error: null, renderOptions: null, minEngagementScore: 0 };
  const result = await analyzeRecording(job, source, root, async () => {}, { transcribe: async () => [{ start: 0, end: 2, text: 'Actual aligned word.', words: [{ start: 0.1, end: 0.8, word: 'Actual' }] }], rank: async cs => cs.map(c => ({ ...c, start: 0, end: 2, score: 80, title: 'Fixture', explanation: 'Explicit model double.' })) });
  assert.equal(result.transcript.segments[0]?.words?.[0]?.start, 0.1);
});
