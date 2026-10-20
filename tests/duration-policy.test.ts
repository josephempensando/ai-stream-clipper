import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { analysisSettingsSchema, renderSchema, validateEdits } from '../src/shared/validation.js';
import { validateAutoRankings } from '../src/server/models.js';
import { validateCachedRankings } from '../src/server/ranking.js';
import { buildEdl, validateNarrative } from '../src/server/retention.js';
import { retentionSettingsSchema } from '../src/shared/retention.js';
import { createApp } from '../src/server/app.js';
import { JobStore, writeJson } from '../src/server/store.js';
import type { Candidate, Highlight, Job } from '../src/shared/types.js';
import { selectBestHighlights } from '../src/server/analysis.js';
import { JobManager } from '../src/server/jobs.js';
import { validateExportDurations } from '../src/shared/duration.js';

const candidate: Candidate = { id: 'story', start: 0, end: 400, heuristicScore: 10, evidence: [], frameTimes: [], transcript: 'Setup. Reaction. Payoff.', cues: [
  { start: 0, end: 20, text: 'Setup.' }, { start: 20, end: 30, text: 'Reaction.' }, { start: 30, end: 400, text: 'Payoff.' },
] };
const row = { score: 90, title: 'Story', explanation: 'The complete story.', description: 'Source narrative.', start: 0, end: 30 };
const highlight: Highlight = { ...candidate, ...row };
function jobFixture(): Job {
  return { id: randomUUID(), name: 'story.mp4', createdAt: '', status: 'review', stage: 'Ready', progress: 100, media: { duration: 400, width: 640, height: 360, hasAudio: true }, mediaHash: 'fixture', source: 'upload', vodId: null, vodOffset: 0, highlights: [highlight], outputs: [], warnings: [], error: null, renderOptions: null };
}

test('manual and API clip edits require 30 seconds, including fractional boundaries', () => {
  for (const end of [0.1, 29, 29.999]) {
    assert.throws(() => validateEdits([{ id: 'story', start: 0, end }], 400), /30/);
    assert.equal(renderSchema.safeParse({ clips: [{ id: 'story', start: 0, end }], options: { layout: 'blur', cropX: 0.5, subtitles: false } }).success, false);
  }
  assert.doesNotThrow(() => validateEdits([{ id: 'story', start: 0.25, end: 30.25 }], 400));
  assert.doesNotThrow(() => validateEdits([{ id: 'story', start: 2.05, end: 32.05 }], 400));
  assert.equal(renderSchema.safeParse({ clips: [{ id: 'story', start: 2.05, end: 32.05 }], options: { layout: 'blur', cropX: 0.5, subtitles: false } }).success, true);
  assert.doesNotThrow(() => validateEdits([{ id: 'story', start: 0, end: 400 }], 400));
});

test('decimal Whisper boundaries are retained at the exact 30-second minimum', () => {
  const decimal: Candidate = { ...candidate, start: 2.05, end: 32.05, cues: [{ start: 2.05, end: 32.05, text: 'Complete decimal-timed story.' }] };
  const rows = validateAutoRankings({ rankings: { story: { ...row, start: 2.05, end: 32.05 } } }, [decimal]);
  assert.equal(rows.length, 1);
  assert.equal(selectBestHighlights(rows).length, 1);
});

test('AI rejects a short reaction without padding it and preserves meaningful context and unlimited stories', () => {
  const result = (start: number, end: number) => validateAutoRankings({ rankings: { story: { ...row, start, end } } }, [candidate]);
  assert.deepEqual(result(20, 30), []);
  assert.equal(result(0, 30)[0]?.duration, 30);
  assert.equal(result(0, 400)[0]?.duration, 400);
  assert.deepEqual(validateCachedRankings([{ ...highlight, start: 20, end: 30 }], [candidate], true, true), []);
});

test('analysis defaults to five without accepting fixed duration modes', () => {
  assert.equal(analysisSettingsSchema.parse({}).clipCount, 5);
  assert.equal(analysisSettingsSchema.parse({ clipCount: 8 }).clipCount, 8);
  assert.equal(analysisSettingsSchema.safeParse({ durationMode: 'fixed' }).success, false);
});

test('destination comparison accepts the exact limit and rejects actual overflow', () => {
  const destination = { name: 'Destination', maxDurationSeconds: 180 };
  assert.doesNotThrow(() => validateExportDurations([{ id: 'story', duration: 180.00000000000003 }], destination));
  assert.throws(() => validateExportDurations([{ id: 'story', duration: 180.001 }], destination), /review/i);
  assert.throws(() => validateExportDurations([{ id: 'story', duration: 29.999 }]), /30/);
  assert.doesNotThrow(() => validateExportDurations([{ id: 'story', duration: 400 }]));
});

test('pause shortening requests review instead of exporting below 30 seconds', () => {
  const h: Highlight = { ...highlight, end: 31, cues: [{ start: 0, end: 10, text: 'Hook and setup.' }, { start: 13, end: 31, text: 'Escalation and payoff.' }] };
  const n = validateNarrative({ hook: { first: 0, last: 0 }, setup: { first: 0, last: 0 }, escalation: { first: 1, last: 1 }, payoff: { first: 1, last: 1 }, ending: { first: 1, last: 1 }, reason: 'Complete.', loop: false, loopReason: 'Natural ending.', emphasis: [], pauseCuts: [0] }, h);
  assert.throws(() => buildEdl(h, n, [], retentionSettingsSchema.parse({ autoEdit: true, trimPauses: true })), /30.*review|review.*30/i);
  assert.equal(buildEdl(h, n, [], retentionSettingsSchema.parse({ autoEdit: true, trimPauses: false })).duration, 31);
});

test('export API returns a review conflict for destination overflow without scheduling or trimming', async t => {
  const { app, store } = await createApp(path.resolve('test-artifacts', `duration-${randomUUID()}`));
  const job = jobFixture(); await store.save(job);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const response = await fetch(`http://127.0.0.1:${address.port}/api/jobs/${job.id}/render`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clips: [{ id: 'story', start: 0, end: 400 }], options: { layout: 'blur', cropX: 0.5, subtitles: false, destination: { name: 'My platform', maxDurationSeconds: 180 } } }) });
  assert.equal(response.status, 409);
  const body = await response.json() as { code: string; error: string };
  assert.equal(body.code, 'DURATION_REVIEW_REQUIRED'); assert.match(body.error, /review/i);
  assert.equal(store.get(job.id).status, 'review'); assert.deepEqual(store.get(job.id).outputs, []);
  assert.equal(store.get(job.id).highlights[0]?.end, 30);
});

test('loading saved projects removes obsolete short selections and preserves long narratives', async () => {
  const root = path.resolve('test-artifacts', `duration-migration-${randomUUID()}`);
  const original = jobFixture(); original.highlights = [{ ...highlight, id: 'short', start: 20, end: 30 }, { ...highlight, id: 'long', end: 400 }];
  await writeJson(path.join(root, 'jobs', original.id, 'job.json'), original);
  const store = new JobStore(root); await store.init();
  assert.deepEqual(store.get(original.id).highlights.map(h => h.id), ['long']);
  assert.ok(store.get(original.id).warnings.some(w => /30/.test(w)));
});

test('retention export review leaves the project unchanged and releases its reservation', async () => {
  const store = new JobStore(path.resolve('test-artifacts', `duration-rollback-${randomUUID()}`)); await store.init();
  const job = jobFixture(); job.highlights[0] = { ...highlight, end: 400 };
  await store.save(job); await writeJson(path.join(store.dir(job.id), 'transcript.json'), { segments: candidate.cues, language: 'en', model: 'fixture' });
  const before = structuredClone(job);
  const manager = new JobManager(store);
  const settings = retentionSettingsSchema.parse({ autoEdit: false });
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(manager.render(job.id, [{ id: 'story', start: 0, end: 400 }], { layout: 'blur', cropX: 0.5, subtitles: false, retention: settings, destination: { name: 'My destination', maxDurationSeconds: 180 } }), /review/i);
    assert.deepEqual(store.get(job.id), before);
  }
});
