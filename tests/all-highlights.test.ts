import test from 'node:test';
import assert from 'node:assert/strict';
import * as recordingAnalysis from '../src/server/analysis.js';
import * as transcriptAnalysis from '../src/server/transcripts.js';
import { buildCandidates, selectBestHighlights } from '../src/server/analysis.js';
import { transcriptCandidates } from '../src/server/transcripts.js';
import { analysisSettingsSchema, renderSchema, validateEdits } from '../src/shared/validation.js';
import type { Highlight } from '../src/shared/types.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { JobStore, writeJson } from '../src/server/store.js';
import { createApp } from '../src/server/app.js';

const moments: Highlight[] = Array.from({ length: 25 }, (_, i) => ({ id: `good-${i}`, start: i * 20, end: i * 20 + 15, score: 85, title: 'Complete reaction', explanation: 'A complete supported moment.', heuristicScore: 0, evidence: [], transcript: 'Wow, we did it!', frameTimes: [] }));

test('analysis defaults to eight qualifying highlights and accepts legacy all requests', () => {
  assert.equal(analysisSettingsSchema.parse({}).clipCount, 8);
  assert.equal(analysisSettingsSchema.parse({ clipCount: 'all', minEngagementScore: 75 }).minEngagementScore, 75);
});

test('selection limits even legacy all requests to the eight best non-overlapping moments', () => {
  assert.equal(selectBestHighlights(moments, 'all').length, 8);
});

test('quality filtering excludes weak moments and duplicate ranges without filling a quota', () => {
  const weak = { ...moments[0]!, id: 'weak', start: 510, end: 520, score: 40 };
  const duplicate = { ...moments[0]!, id: 'duplicate', score: 80 };
  const select = selectBestHighlights as (rows: Highlight[], count: number | 'all', minimumScore: number) => Highlight[];
  assert.deepEqual(select([...moments, weak, duplicate], 'all', 70).map(h => h.id), moments.slice(0, 8).map(h => h.id));
  assert.deepEqual(select([weak], 'all', 70), []);
});

test('exports accept more than twenty validated clips', () => {
  const clips = moments.map(({ id, start, end }) => ({ id, start, end }));
  assert.doesNotThrow(() => validateEdits(clips, 530));
  assert.equal(renderSchema.parse({ clips, options: { layout: 'blur', cropX: 0.5, subtitles: false } }).clips.length, 25);
});

test('recording and transcript analysis cover every cue beyond the previous 120-context sample', () => {
  const cues = Array.from({ length: 150 }, (_, i) => ({ start: i * 10, end: i * 10 + 5, text: `Complete moment ${i}.` }));
  assert.equal(buildCandidates(cues, [], 1500).filter(c => c.cues?.length).length, 150);
  assert.equal(transcriptCandidates(cues, 1500).length, 150);
});

test('large short-cue recordings retain lightweight contexts and materialize only the requested batch', () => {
  const cues = Array.from({ length: 25_000 }, (_, i) => ({ start: i, end: i + 1, text: 'Hi' }));
  assert.equal(typeof recordingAnalysis.buildCandidateContexts, 'function');
  assert.equal(typeof transcriptAnalysis.transcriptContexts, 'function');
  for (const contexts of [recordingAnalysis.buildCandidateContexts(cues, [], 25_000), transcriptAnalysis.transcriptContexts(cues, 25_000)]) {
    assert.equal(contexts.length, 25_000);
    assert.equal(Object.hasOwn(contexts[0]!, 'cues'), false);
    assert.equal(Object.hasOwn(contexts[0]!, 'transcript'), false);
    assert.deepEqual(contexts.slice(-3).map(c => c.materialize().cues?.[0]?.start), [24_997, 24_998, 24_999]);
    assert.equal(contexts.at(-1)!.materialize().end, 25_000);
  }
});

test('legacy unlimited jobs migrate to eight while saved numeric limits survive omitted analyze settings', async t => {
  const root = path.resolve('test-artifacts', `all-migration-${randomUUID()}`);
  const fixture = { name: 'test.mp4', createdAt: new Date().toISOString(), status: 'uploaded', stage: 'Ready', progress: 0, media: { duration: 300, width: 640, height: 360, hasAudio: false }, mediaHash: 'hash', source: 'upload', vodId: null, vodOffset: 0, highlights: [], outputs: [], warnings: [], error: null, renderOptions: null };
  const oldId = randomUUID(); const newId = randomUUID(); const oversizedId = randomUUID();
  const store = new JobStore(root);
  await writeJson(path.join(store.dir(oldId), 'job.json'), { ...fixture, id: oldId, clipCount: 'all' });
  await writeJson(path.join(store.dir(newId), 'job.json'), { ...fixture, id: newId, clipCount: 2, selectionVersion: 1 });
  await writeJson(path.join(store.dir(oversizedId), 'job.json'), { ...fixture, id: oversizedId, clipCount: 25, minEngagementScore: 95, selectionVersion: 1 });
  await store.init();
  assert.equal(store.get(oldId).clipCount, 8); assert.equal(store.get(newId).clipCount, 2);
  assert.equal(store.get(oversizedId).clipCount, 8); assert.equal(store.get(oversizedId).minEngagementScore, 95);
  const { app, manager, oauth, twitchLive } = await createApp(root);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => { oauth.close(); twitchLive.close(); server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const response = await fetch(`http://127.0.0.1:${address.port}/api/jobs/${newId}/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 202); assert.equal((await response.json()).clipCount, 2);
  await manager.idle();
});
