import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createApp } from '../src/server/app.js';
import { TwitchClient } from '../src/server/twitch.js';
import { TwitchOAuth } from '../src/server/twitch-oauth.js';

const vod = { id: '123', title: 'Stream', user_id: '42', user_name: 'caseoh_', duration: '2h', thumbnail_url: '', url: 'https://www.twitch.tv/videos/123', created_at: '2026-10-09T00:00:00Z', view_count: 100 };
const clip = { id: 'LiveClip', url: 'https://clips.twitch.tv/LiveClip', embed_url: 'https://clips.twitch.tv/embed?clip=LiveClip', broadcaster_id: '42', broadcaster_name: 'CaseOh', creator_id: '7', creator_name: 'viewer', video_id: '123', game_id: '1', language: 'en', title: 'Live moment', view_count: 1, created_at: '2026-10-09T00:00:00Z', thumbnail_url: 'https://static-cdn.jtvnw.net/clip.jpg', duration: 45, vod_offset: 100 };
async function fixture(t: TestContext) {
  let live = true; let permissionStatus = 202; let ready = false; let creations = 0;
  const request: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/token')) return Response.json({ access_token: 'secret-access', refresh_token: 'secret-refresh', expires_in: 3600 });
    if (url.pathname.endsWith('/validate')) return Response.json({ client_id: 'client', user_id: '7', login: 'viewer', scopes: ['clips:edit'], expires_in: 3600 });
    if (url.pathname.endsWith('/videos')) return Response.json({ data: [vod] });
    if (url.pathname.endsWith('/users')) return Response.json({ data: [{ id: '42', login: 'caseoh_', display_name: 'CaseOh' }] });
    if (url.pathname.endsWith('/streams')) return Response.json({ data: live ? [{ id: 'stream', title: 'Live!', viewer_count: 100, started_at: '2026-10-09', game_name: 'Gaming' }] : [] });
    if (init.method === 'POST') { creations++; assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer secret-access'); return Response.json(permissionStatus === 202 ? { data: [{ id: 'LiveClip', edit_url: 'https://www.twitch.tv/caseoh_/clip/LiveClip' }] } : {}, { status: permissionStatus, headers: permissionStatus === 429 ? { 'Retry-After': '5' } : {} }); }
    return Response.json({ data: ready || !url.searchParams.has('id') ? [clip] : [], pagination: {} });
  };
  const oauth = new TwitchOAuth({ clientId: 'client', secret: 'server-secret', redirectUri: 'http://127.0.0.1:5173/api/twitch/oauth/callback', appOrigin: 'http://127.0.0.1:5173' }, request);
  const root = path.resolve('test-artifacts', `viewer-${randomUUID()}`);
  const result = await createApp(root, undefined, { twitch: new TwitchClient({ clientId: 'client', secret: 'server-secret', userToken: '' }, request), oauth });
  const server = result.app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => { result.twitchLive.close(); oauth.close(); server.closeAllConnections(); server.close(); });
  const addr = server.address(); assert.ok(addr && typeof addr !== 'string'); const base = `http://127.0.0.1:${addr.port}/api/twitch`;
  const post = (route: string, body: unknown = {}, cookie = '') => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body), redirect: 'manual' });
  const connect = async () => {
    const start = await post('/oauth/connect'); const data = await start.json() as { url: string };
    const browser = start.headers.get('set-cookie')!.split(';')[0]!;
    const callback = await fetch(`${base}/oauth/callback?code=code&state=${new URL(data.url).searchParams.get('state')}`, { headers: { Cookie: browser }, redirect: 'manual' });
    assert.equal(callback.status, 303); assert.equal(callback.headers.get('location'), 'http://127.0.0.1:5173/?twitch=connected');
    assert.ok(callback.headers.get('set-cookie')!.includes('HttpOnly')); assert.ok(callback.headers.get('set-cookie')!.includes('SameSite=Lax'));
    return callback.headers.getSetCookie().find(c => c.startsWith('twitch_session='))!.split(';')[0]!;
  };
  return { ...result, base, root, post, connect, setLive: (value: boolean) => { live = value; }, setPermission: (status: number) => { permissionStatus = status; }, setReady: () => { ready = true; }, creations: () => creations };
}
test('public route exposes real clip count, public ranking and no download links', async t => {
  const f = await fixture(t); const response = await fetch(`${f.base}/discover?input=123`); assert.equal(response.status, 200);
  const data = await response.json() as { clips: { id: string }[]; analysis: string }; assert.equal(data.clips.length, 1); assert.equal(data.analysis, 'public-metadata');
  assert.ok(!JSON.stringify(data).includes('download_url'));
});
test('viewer API requires OAuth, rechecks live status, stores pending IDs and confirms readiness', async t => {
  const f = await fixture(t); const input = { channel: 'caseoh_', title: 'Live moment', duration: 45 };
  assert.equal((await f.post('/live/clips', input)).status, 401); assert.equal(f.creations(), 0);
  const cookie = await f.connect();
  f.setLive(false); assert.equal((await f.post('/live/clips', input, cookie)).status, 409); assert.equal(f.creations(), 0);
  f.setLive(true); const created = await f.post('/live/clips', input, cookie); assert.equal(created.status, 202);
  assert.equal((await created.json() as { status: string }).status, 'pending');
  f.setReady(); const confirmed = await fetch(`${f.base}/live/clips/LiveClip`, { headers: { Cookie: cookie } }); assert.equal((await confirmed.json() as { status: string }).status, 'ready');
  const history = await fetch(`${f.base}/live/clips`, { headers: { Cookie: cookie } }); assert.equal((await history.json() as unknown[]).length, 1);
  const saved = await readFile(path.join(f.root, 'twitch-live-clips.json'), 'utf8'); assert.ok(saved.includes('LiveClip')); assert.ok(!saved.includes('secret'));
  assert.equal((await f.post('/oauth/disconnect', {}, cookie)).status, 200); assert.equal((await fetch(`${f.base}/live/clips`, { headers: { Cookie: cookie } })).status, 401);
});
test('OAuth callback rejects missing browser state and never redirects to caller destinations', async t => {
  const f = await fixture(t); const response = await fetch(`${f.base}/oauth/callback?state=fake&code=code&returnUrl=https://evil.test`, { redirect: 'manual' });
  assert.equal(response.status, 401); assert.equal(response.headers.get('location'), null);
  assert.equal((await f.post('/live/clips', { channel: 'https://evil.test', title: 'Title', duration: 45 })).status, 401);
  const mismatch = await fetch(`${f.base}/oauth/connect`, { method: 'POST', headers: { Origin: 'http://localhost:5173', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(mismatch.status, 400); assert.match((await mismatch.json() as { error: string }).error, /127\.0\.0\.1:5173/);
});
test('viewer permission denial and rate limiting propagate actionable statuses', async t => {
  for (const status of [403, 429]) {
    const f = await fixture(t); const cookie = await f.connect(); f.setPermission(status);
    const response = await f.post('/live/clips', { channel: 'caseoh_', title: 'Live moment', duration: 45 }, cookie);
    assert.equal(response.status, status); if (status === 429) assert.ok(Number(response.headers.get('retry-after')) >= 1);
    assert.equal(f.creations(), 1);
  }
});
