import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server/app.js';
import { TimestampAnalyzer } from '../src/server/timestamp-analyzer.js';
import { TwitchClient } from '../src/server/twitch.js';
import { YouTubeClient } from '../src/server/youtube.js';
async function apiFixture(t: TestContext) {
  const root = path.resolve('test-artifacts', `timestamp-api-${randomUUID()}`);
  const twitch = new TwitchClient({ clientId: 'client', secret: '', userToken: 'token' }, async () => Response.json({ data: [{ id: '123', title: 'Stream', user_id: '42', user_name: 'CaseOh', duration: '2h', thumbnail_url: '', url: 'https://www.twitch.tv/videos/123', created_at: '2026-10-09', view_count: 5 }] }));
  const youtube = new YouTubeClient('server-only-secret', async () => Response.json({ items: [{ id: 'abcdefghijk', snippet: { title: 'Stream', channelTitle: 'Creator' }, contentDetails: { duration: 'PT5M' }, status: { embeddable: true } }] }));
  const analyzer = new TimestampAnalyzer(twitch, youtube, root, async cs => cs.map(c => ({ ...c, end: Math.min(c.end, c.start + 10), score: 70, title: 'Supported moment', explanation: 'Context supplied in the transcript.' })));
  const services = await createApp(root, undefined, { analyzer }); const server = services.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => { services.oauth.close(); services.twitchLive.close(); server.closeAllConnections(); server.close(); });
  const addr = server.address(); assert.ok(addr && typeof addr !== 'string');
  return { ...services, base: `http://127.0.0.1:${addr.port}/api/analyzer` };
}
test('analyzer API returns honest YouTube unavailable state without a transcript or media job', async t => {
  const f = await apiFixture(t); const response = await fetch(`${f.base}/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: 'https://youtu.be/abcdefghijk' }) });
  assert.equal(response.status, 200); const data = await response.json() as { status: string; highlights: unknown[] };
  assert.equal(data.status, 'unavailable'); assert.deepEqual(data.highlights, []); assert.ok(!JSON.stringify(data).includes('server-only-secret')); assert.equal(f.store.jobs.size, 0);
});
test('permitted multipart transcript returns five timestamps, no MP4 exports or media jobs', async t => {
  const f = await apiFixture(t);
  const form = (permission: string) => {
    const body = new FormData(); body.append('input', 'https://www.youtube.com/live/abcdefghijk'); body.append('permission', permission);
    body.append('transcript', new Blob([JSON.stringify({ segments: Array.from({ length: 60 }, (_, i) => ({ start: i * 5, end: i * 5 + 5, text: 'A surprising setup and payoff for this round.' })) })]), 'authorized.json'); return body;
  };
  assert.equal((await fetch(`${f.base}/analyze`, { method: 'POST', body: form('false') })).status, 400);
  const response = await fetch(`${f.base}/analyze`, { method: 'POST', body: form('true') }); assert.equal(response.status, 200);
  const data = await response.json() as { highlights: { startTime: string; endTime: string; originalUrl: string }[]; dataSource: string };
  assert.equal(data.highlights.length, 5); assert.equal(data.dataSource, 'transcript'); assert.ok(data.highlights.every(h => h.startTime && h.endTime && h.originalUrl.startsWith('https://www.youtube.com/watch?'))); assert.equal(f.store.jobs.size, 0);
});
test('analyzer rejects hostile URLs, untimed files, oversized attachments and foreign origins', async t => {
  const f = await apiFixture(t);
  assert.equal((await fetch(`${f.base}/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: 'https://127.0.0.1/secret' }) })).status, 400);
  for (const [name, text, expected] of [['bad.txt', 'No timestamped evidence', 400], ['large.txt', 'x'.repeat(2 * 1024 ** 2 + 1), 413]] as const) {
    const body = new FormData(); body.append('input', 'https://youtu.be/abcdefghijk'); body.append('permission', 'true'); body.append('transcript', new Blob([text]), name);
    assert.equal((await fetch(`${f.base}/analyze`, { method: 'POST', body })).status, expected);
  }
  assert.equal((await fetch(`${f.base}/status`, { headers: { Origin: 'https://evil.test' } })).status, 403);
});
