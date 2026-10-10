import test from 'node:test';
import assert from 'node:assert/strict';
import { TwitchClient } from '../src/server/twitch.js';
import { parseChannelLogin, rankPublicClips, publicClipSchema } from '../src/server/twitch-public.js';
import { TwitchApiError } from '../src/server/twitch-http.js';

export const vodFixture = { id: '123', title: 'Stream', user_id: '42', user_name: 'caseoh_', duration: '2h', thumbnail_url: '', url: 'https://www.twitch.tv/videos/123', created_at: '2026-10-09T00:00:00Z', view_count: 100 };
export const clipFixture = (id: string, overrides = {}) => ({ id, url: `https://clips.twitch.tv/${id}`, embed_url: `https://clips.twitch.tv/embed?clip=${id}`, broadcaster_id: '42', broadcaster_name: 'CaseOh', creator_id: '7', creator_name: 'viewer', video_id: '123', game_id: '1', language: 'en', title: 'Unexpected reaction!', view_count: 100, created_at: '2026-10-09T00:00:00Z', thumbnail_url: 'https://static-cdn.jtvnw.net/clip.jpg', duration: 45, vod_offset: 100, ...overrides });
export function publicClient(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  return new TwitchClient({ clientId: 'client', secret: 'secret', userToken: '' }, async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.pathname === '/oauth2/token') return Response.json({ access_token: 'app-only', expires_in: 3600 });
    if (u.pathname === '/helix/videos') return Response.json({ data: [vodFixture] });
    return handler(u, init);
  });
}
test('public discovery paginates, deduplicates and filters exact VOD and 30–60s duration', async () => {
  const queries: URL[] = [];
  const client = publicClient(url => { queries.push(url); return Response.json(url.searchParams.has('after') ? { data: [clipFixture('One'), clipFixture('Two', { duration: 60, view_count: 400 }), clipFixture('Wrong', { video_id: '999' })], pagination: {} } : { data: [clipFixture('One', { duration: 30 }), clipFixture('Short', { duration: 29.9 }), clipFixture('Unlinked', { video_id: '' })], pagination: { cursor: 'page2' } }); });
  const result = await client.discover('https://www.twitch.tv/videos/123');
  assert.equal(queries.length, 2); assert.equal(queries[0]?.searchParams.get('broadcaster_id'), '42');
  assert.equal(queries[0]?.searchParams.get('first'), '100'); assert.equal(queries[1]?.searchParams.get('after'), 'page2');
  assert.equal(result.matched, 3); assert.equal(result.eligible, 2); assert.deepEqual(result.clips.map(c => c.id), ['Two', 'One']);
  assert.equal(result.analysis, 'public-metadata'); assert.equal(result.truncated, false);
});
test('discovery respects ten-page limit and reports incomplete search', async () => {
  let pages = 0;
  const result = await publicClient(() => Response.json({ data: [clipFixture(`Clip${++pages}`)], pagination: { cursor: String(pages) } })).discover('123');
  assert.equal(pages, 10); assert.equal(result.clips.length, 5); assert.equal(result.truncated, true);
});
test('discovery handles zero matching clips and repeated cursors without inventing results', async () => {
  const result = await publicClient(() => Response.json({ data: [clipFixture('Other', { video_id: '999' })], pagination: { cursor: 'same' } })).discover('123');
  assert.equal(result.clips.length, 0); assert.equal(result.pages, 2); assert.equal(result.truncated, true);
});
test('ranking uses views and title evidence, exposes metadata explanation and stays deterministic', () => {
  const ranked = rankPublicClips([publicClipSchema.parse(clipFixture('Low', { view_count: 1 })), publicClipSchema.parse(clipFixture('High', { view_count: 10000 }))]);
  assert.equal(ranked[0]?.id, 'High'); assert.match(ranked[0]!.explanation, /views/); assert.ok(ranked.every(c => c.score >= 0 && c.score <= 100));
});
test('channel input only accepts Twitch profile URLs or login names', () => {
  assert.equal(parseChannelLogin('https://www.twitch.tv/KaiCenat'), 'kaicenat'); assert.equal(parseChannelLogin('caseoh_'), 'caseoh_');
  for (const input of ['https://evil.test/caseoh_', 'https://twitch.tv@evil.test/caseoh_', 'https://twitch.tv/videos/123', 'https://twitch.tv:444/caseoh_', 'https://twitch.tv/caseoh_?redirect=evil']) assert.throws(() => parseChannelLogin(input));
});
test('public clips accept Twitch documented thumbnail hosts and reject unrelated hosts', () => {
  for (const host of ['clips-media-assets.twitch.tv', 'clips-media-assets2.twitch.tv', 'static-cdn.jtvnw.net', 'production.assets.clips.twitchcdn.net']) {
    assert.equal(publicClipSchema.safeParse(clipFixture('Example', { thumbnail_url: `https://${host}/thumbnail.jpg` })).success, true);
  }
  for (const host of ['evil.test', 'clips-media-assets.twitch.tv.evil.test', 'eviljtvnw.net']) assert.equal(publicClipSchema.safeParse(clipFixture('Example', { thumbnail_url: `https://${host}/thumbnail.jpg` })).success, false);
});
test('rate limits expose reset and do not repeat Create Clip POST', async () => {
  let calls = 0; const client = publicClient(() => { calls++; return Response.json({}, { status: 429, headers: { 'Ratelimit-Reset': String(Math.ceil(Date.now() / 1000) + 5) } }); });
  await assert.rejects(client.createLiveClip('42', 'viewer-token', 'Moment', 45), e => e instanceof TwitchApiError && e.status === 429 && e.retryAfter > 0);
  await assert.rejects(client.createLiveClip('42', 'viewer-token', 'Moment', 45), /rate limit/i); assert.equal(calls, 1);
});
test('live status resolves Get Users and Get Streams; channel errors are actionable', async () => {
  const client = publicClient(url => url.pathname.endsWith('/users') ? Response.json({ data: [{ id: '42', login: 'caseoh_', display_name: 'CaseOh' }] }) : Response.json({ data: [] }));
  const status = await client.live('caseoh_'); assert.equal(status.live, false); assert.equal(status.broadcaster.id, '42');
  await assert.rejects(publicClient(() => Response.json({ data: [] })).live('missing'), /not found/i);
  await assert.rejects(publicClient(() => Response.json({}, { status: 403 })).createLiveClip('42', 'token', 'Title', 45), /followers|permission|disabled/i);
});
