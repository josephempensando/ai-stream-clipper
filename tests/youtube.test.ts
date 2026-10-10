import test from 'node:test';
import assert from 'node:assert/strict';
import { YouTubeClient, parseYouTubeDuration } from '../src/server/youtube.js';
test('YouTube official API resolves only requested IDs with credentials server-side', async () => {
  const client = new YouTubeClient('server-secret-key', async input => {
    const url = new URL(String(input)); assert.equal(url.origin, 'https://www.googleapis.com'); assert.equal(url.pathname, '/youtube/v3/videos');
    assert.equal(url.searchParams.get('id'), 'abcdefghijk'); assert.ok(url.searchParams.get('part')?.includes('contentDetails'));
    return Response.json({ items: [{ id: 'abcdefghijk', snippet: { title: 'Stream', channelTitle: 'Channel', liveBroadcastContent: 'none' }, contentDetails: { duration: 'PT1H2M3S' }, statistics: { viewCount: '123' }, status: { embeddable: false, privacyStatus: 'public' } }] });
  });
  const result = await client.video('abcdefghijk'); assert.equal(result.duration, 3723); assert.equal(result.embedAllowed, false); assert.ok(!JSON.stringify(result).includes('server-secret'));
  assert.equal(parseYouTubeDuration('P1DT2H3M4.5S'), 93784.5);
});
test('YouTube missing credentials, inaccessible resources and quotas produce honest errors without leaking key', async () => {
  await assert.rejects(new YouTubeClient('').video('abcdefghijk'), /YOUTUBE_API_KEY/);
  await assert.rejects(new YouTubeClient('secret', async () => Response.json({ items: [] })).video('abcdefghijk'), /unavailable|not found/i);
  await assert.rejects(new YouTubeClient('secret', async () => Response.json({ error: { message: 'secret' } }, { status: 403 })).video('abcdefghijk'), e => e instanceof Error && /quota|API key/i.test(e.message) && !e.message.includes('secret'));
});
