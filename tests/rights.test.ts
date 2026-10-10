import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server/app.js';
import { JobStore, readJson } from '../src/server/store.js';
import { JobManager } from '../src/server/jobs.js';
import type { Job } from '../src/shared/types.js';
import { assessRights, sourceRightsSchema } from '../src/shared/rights.js';

const complete = { originalCreator: 'Test creator', sourceUrl: 'https://example.org/source', category: 'licensed', permissionEvidence: 'License document reference 7', licenseUrl: 'https://example.org/license', ccLicense: '', conditions: '', allowedPlatforms: ['tiktok'], allowedUses: ['private-analysis', 'excerpt', 'publish'], expiresAt: null };

test('Creative Commons restrictions cannot be removed by checking allowed uses', () => {
  const nc = assessRights({ ...complete, category: 'creative-commons', ccLicense: 'CC BY-NC-SA 4.0', allowedUses: ['publish', 'commercial', 'adaptation'] });
  assert.equal(nc.status, 'restricted');
  assert.ok(nc.issues.some(issue => /NonCommercial/.test(issue)));
  assert.ok(nc.conditions.some(condition => /ShareAlike/.test(condition)));
  assert.ok(nc.conditions.some(condition => /Credit/.test(condition)));
  const nd = assessRights({ ...complete, category: 'creative-commons', ccLicense: 'CC BY-ND 4.0', allowedUses: ['publish', 'adaptation'] });
  assert.ok(nd.issues.some(issue => /NoDerivatives/.test(issue)));
  assert.equal(assessRights({ category: 'claimed-exception' }).status, 'review-required');
  assert.equal(assessRights({ ...complete, category: 'prohibited' }).status, 'prohibited');
});

test('permission expires at the recorded instant; complete declarations still do not clear publishing', () => {
  const rights = { ...complete, expiresAt: '2030-01-01T00:00:00.000Z' };
  assert.equal(assessRights(rights, { now: new Date('2029-12-31T23:59:59.999Z') }).status, 'recorded');
  assert.equal(assessRights(rights, { now: new Date('2030-01-01T00:00:00.000Z') }).status, 'expired');
  assert.equal(assessRights(complete).automatedPublishingAllowed, false);
  assert.throws(() => sourceRightsSchema.parse({ ...complete, allowedPlatforms: ['arbitrary-platform'] }));
});

test('legacy rights stay unknown; rights editing persists restrictions and never grants automated publishing', async t => {
  const root = path.resolve('test-artifacts', `rights-${randomUUID()}`);
  const store = new JobStore(root); await store.init();
  const id = randomUUID();
  const job: Job = { id, name: 'local-file.mp4', createdAt: new Date().toISOString(), status: 'uploaded', stage: '', progress: 0, media: { duration: 90, width: 160, height: 90, hasAudio: true }, mediaHash: 'fixture', source: 'upload', vodId: null, vodOffset: 0, highlights: [], outputs: [], warnings: [], error: null, renderOptions: null };
  await store.save(job);
  const { app } = await createApp(root, new JobManager(store));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/jobs/${id}/rights`;
  const missing = await fetch(url); assert.equal(missing.status, 200);
  const unknown = await missing.json();
  assert.equal(unknown.rights.category, 'unknown');
  assert.equal(unknown.assessment.status, 'unestablished');
  assert.equal(unknown.assessment.automatedPublishingAllowed, false);
  const rights = { originalCreator: 'Original creator', sourceUrl: 'https://example.org/source', category: 'licensed', permissionEvidence: 'Written grant, reference PERM-123', licenseUrl: 'https://example.org/license', ccLicense: '', conditions: 'TikTok only, no monetization', allowedPlatforms: ['tiktok'], allowedUses: ['private-analysis', 'excerpt', 'publish'], expiresAt: '2020-01-01T00:00:00.000Z' };
  const put = async (value: unknown) => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  assert.equal((await put(rights)).status, 200);
  const expired = await (await fetch(`${url}?platform=youtube-shorts&use=commercial`)).json();
  assert.equal(expired.assessment.status, 'expired');
  assert.ok(expired.assessment.issues.some((issue: string) => /platform/i.test(issue)));
  assert.ok(expired.assessment.issues.some((issue: string) => /commercial/i.test(issue)));
  assert.equal(expired.assessment.automatedPublishingAllowed, false);
  assert.equal((await put({ ...rights, expiresAt: 'not-a-date' })).status, 400);
  assert.equal((await put({ ...rights, sourceUrl: 'javascript:alert(1)' })).status, 400);
  assert.equal((await put({ ...rights, automatedPublishingAllowed: true })).status, 400);
  const simultaneous = await Promise.all(Array.from({ length: 20 }, (_, i) => put({ ...rights, originalCreator: `Creator ${i}` })));
  assert.ok(simultaneous.every(response => response.status === 200), `Concurrent rights writes failed: ${simultaneous.map(response => response.status)}`);
  assert.deepEqual((await readJson<Job>(path.join(store.dir(id), 'job.json')))?.rights, store.get(id).rights);
  const restarted = new JobStore(root); await restarted.init();
  assert.deepEqual((await (await fetch(url)).json()).rights, restarted.get(id).rights);
});
