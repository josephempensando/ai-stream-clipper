import test from 'node:test';
import assert from 'node:assert/strict';
import { TwitchClient } from '../src/server/twitch.js';

function fakeTwitch(scope = 'channel:manage:clips', clientId = 'client') {
  const requests: { url: URL; init: RequestInit }[] = [];
  const request: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input)); requests.push({ url, init });
    if (url.pathname.endsWith('/validate')) return Response.json({ client_id: clientId, user_id: '42', scopes: [scope], expires_in: 3600 });
    if (url.pathname.endsWith('/downloads')) return Response.json({ data: [{ clip_id: 'clip-test', landscape_download_url: 'https://production.assets.clips.twitchcdn.net/authorized.mp4', portrait_download_url: null }] });
    if (url.pathname.endsWith('/videos/clips')) return Response.json({ data: [{ id: 'clip-test', edit_url: 'https://www.twitch.tv/editor/clip/clip-test' }] }, { status: 202 });
    return Response.json({ data: [{ id: '123', title: 'My stream', user_id: '42', user_name: 'owner', duration: '2h3m4s', thumbnail_url: '', url: 'https://www.twitch.tv/videos/123', created_at: '2026-10-09', view_count: 4 }] });
  };
  return { client: new TwitchClient({ clientId: 'client', secret: '', userToken: 'server-only-token' }, request), requests };
}
test('official create-from-VOD sends end timestamp, duration, title and validated OAuth identity', async () => {
  const { client, requests } = fakeTwitch();
  const result = await client.createClip({ vodId: '123', start: 120, end: 165, title: 'My moment' });
  const create = requests.find(r => r.url.pathname.endsWith('/videos/clips'))!;
  assert.equal(create.url.searchParams.get('vod_offset'), '165'); assert.equal(create.url.searchParams.get('duration'), '45');
  assert.equal(create.url.searchParams.get('editor_id'), '42'); assert.equal(create.init.method, 'POST');
  assert.equal(result.id, 'clip-test');
  assert.equal((await client.downloads('42', result.id))[0]?.portrait_download_url, null);
});
test('Twitch refuses missing scopes and mismatched OAuth client before mutation', async () => {
  for (const fixture of [fakeTwitch('clips:edit'), fakeTwitch('channel:manage:clips', 'other')]) {
    await assert.rejects(fixture.client.createClip({ vodId: '123', start: 0, end: 45, title: 'Moment' }));
    assert.ok(!fixture.requests.some(r => r.init.method === 'POST'));
  }
});
test('Twitch rejects fractional end seconds and outside-VOD ranges', async () => {
  const { client } = fakeTwitch();
  await assert.rejects(client.createClip({ vodId: '123', start: 0, end: 45.5, title: 'Moment' }));
  await assert.rejects(client.createClip({ vodId: '123', start: 8000, end: 8045, title: 'Moment' }));
});

test('official Twitch API retains its separate duration limits', async () => {
  const { client, requests } = fakeTwitch();
  for (const end of [12, 85]) await assert.rejects(client.createClip({ vodId: '123', start: 0, end, title: 'Moment' }), /30–60/);
  assert.ok(!requests.some(r => r.init.method === 'POST'));
});
test('broadcaster can use either of Twitch documented manage-clips scopes', async () => {
  const { client } = fakeTwitch('editor:manage:clips');
  assert.equal((await client.createClip({ vodId: '123', start: 0, end: 45, title: 'Moment' })).id, 'clip-test');
});
