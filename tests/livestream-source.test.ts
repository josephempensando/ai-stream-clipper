import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVodId } from '../src/shared/validation.js';
import { parseLivestreamSource, formatTimestamp, timestampLink, analysisCsv } from '../src/shared/livestream.js';
test('Twitch schedule vodID resolves safely and preserves standard VOD parser', () => {
  assert.equal(parseVodId('https://www.twitch.tv/caseoh_/schedule?vodID=2895693134'), '2895693134');
  assert.equal(parseVodId('https://www.twitch.tv/videos/123?t=1h'), '123');
  for (const url of ['https://evil.test/caseoh_/schedule?vodID=123', 'https://www.twitch.tv/caseoh_/schedule?vodID=bad', 'https://twitch.tv/caseoh_/schedule?vodID=123&vodID=456', 'https://www.twitch.tv/videos/123?vodID=456']) assert.throws(() => parseVodId(url));
});
test('YouTube watch/live/short links resolve to canonical public source and reject forged hosts', () => {
  for (const url of ['https://www.youtube.com/watch?v=abcdefghijk&t=20', 'https://youtube.com/live/abcdefghijk', 'https://youtu.be/abcdefghijk?si=test']) assert.deepEqual(parseLivestreamSource(url), { platform: 'youtube', id: 'abcdefghijk', url: 'https://www.youtube.com/watch?v=abcdefghijk' });
  assert.equal(parseLivestreamSource('https://twitch.tv/caseoh_/schedule?vodID=123').platform, 'twitch');
  for (const url of ['https://youtube.com.evil.test/watch?v=abcdefghijk', 'https://youtube.com@evil.test/watch?v=abcdefghijk', 'https://youtube.com:444/watch?v=abcdefghijk', 'https://youtube.com/watch?v=abcdefghijk&v=01234567890', 'https://youtube.com/watch?v=short', 'http://youtu.be/abcdefghijk', 'https://youtube.com/channel/abcdefghijk']) assert.throws(() => parseLivestreamSource(url));
});
test('timestamp helpers retain hours and fractional precision and generate official seek links', () => {
  assert.equal(formatTimestamp(3661), '01:01:01'); assert.equal(formatTimestamp(30.125), '00:00:30.125');
  assert.equal(timestampLink('twitch', '123', 3661), 'https://www.twitch.tv/videos/123?t=1h1m1s');
  assert.equal(timestampLink('youtube', 'abcdefghijk', 65), 'https://www.youtube.com/watch?v=abcdefghijk&t=65s');
});
test('CSV correctly quotes public titles and neutralizes spreadsheet formulas', () => {
  const csv = analysisCsv({ source: { platform: 'twitch', id: '123', url: 'https://twitch.tv/videos/123', title: 'Stream', creator: 'CaseOh', duration: 3600, viewCount: 0, thumbnailUrl: '', isLive: false, embedAllowed: true }, status: 'ready', dataSource: 'existing-clips', confidence: 'metadata-only', confidenceExplanation: 'Timing from official clip metadata', analyzedAt: '', warnings: [], scan: null, highlights: [{ id: 'one', start: 10, end: 40, startTime: '00:00:10', endTime: '00:00:40', duration: 30, title: '=SUM(1,2)', description: 'He said "wow", then won', score: 50, viewCount: 100, clipUrl: 'https://clips.twitch.tv/one', originalUrl: 'https://www.twitch.tv/videos/123?t=0h0m10s', dataSource: 'existing-clips', confidence: 'metadata-only', transcript: null }] });
  assert.ok(csv.includes("'=SUM(1,2)")); assert.ok(csv.includes('"He said ""wow"", then won"')); assert.ok(csv.includes('00:00:10'));
});
