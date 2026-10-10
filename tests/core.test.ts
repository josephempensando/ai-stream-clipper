import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVodId, validateEdits } from '../src/shared/validation.js';

test('VOD parser normalizes the supplied malformed scheme and preserves the URL ID', () => {
  assert.equal(parseVodId('https//www.twitch.tv/videos/2895693134'), '2895693134');
  assert.equal(parseVodId('289563134'), '289563134');
  assert.equal(parseVodId('https://www.twitch.tv/videos/2895693134?t=1h'), '2895693134');
});
test('VOD parser rejects foreign hosts, credential URLs, non-VOD paths and trailing garbage', () => {
  for (const input of ['https://twitch.tv.evil.test/videos/123', 'https://user@twitch.tv/videos/123', 'https://twitch.tv/name', '123bad']) {
    assert.throws(() => parseVodId(input));
  }
});
test('clip edits allow natural short and long ranges while enforcing recording bounds, IDs and non-overlap', () => {
  assert.doesNotThrow(() => validateEdits([{ id: 'a', start: 0, end: 30 }, { id: 'b', start: 30, end: 90 }], 90));
  assert.doesNotThrow(() => validateEdits([{ id: 'short', start: 0, end: 12 }, { id: 'long', start: 12, end: 200 }], 200));
  for (const edits of [
    [{ id: 'a', start: 10, end: 10 }], [{ id: 'a', start: 20, end: 10 }],
    [{ id: 'a', start: 70, end: 100 }], [{ id: 'a', start: -1, end: 30 }],
    [{ id: 'a', start: 0, end: 40 }, { id: 'b', start: 30, end: 60 }],
    [{ id: 'a', start: 0, end: 30 }, { id: 'a', start: 40, end: 70 }],
  ]) assert.throws(() => validateEdits(edits, 90));
});
