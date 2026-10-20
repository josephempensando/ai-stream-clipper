import test from 'node:test';
import assert from 'node:assert/strict';
import { storySettingsSchema, storyStats, storyPreviewExcerpt } from '../src/shared/story.js';

const valid = { script: 'One two three.', voiceId: 'en_US-lessac-medium', rights: { footagePermission: true } };
test('story settings accept short scripts independently of clipping limits and preserve exact text', () => {
  const parsed = storySettingsSchema.parse(valid);
  assert.equal(parsed.script, valid.script); assert.equal(parsed.speed, 1);
  assert.equal(parsed.backgroundMuted, true);
  assert.deepEqual(storyStats(valid.script, 1), { words: 3, characters: 14, estimatedSeconds: 1.2 });
  assert.equal(storyStats('One two three.', 1.5).estimatedSeconds, 0.8);
  assert.equal(storyPreviewExcerpt('hello '.repeat(49) + 'wonderful'), 'hello '.repeat(49).trim());
  assert.equal(storyPreviewExcerpt('x'.repeat(301)), '');
});
test('story validation rejects unauthorized assets, oversized scripts and invalid controls', () => {
  for (const change of [
    { script: '   ' }, { script: 'a\0b' }, { script: 'x'.repeat(30_001) },
    { rights: { footagePermission: false } }, { speed: 0.74 }, { speed: 1.51 },
    { backgroundGainDb: Number.NaN }, { voiceId: '../../secret' }, { unknown: true },
    { rights: { footagePermission: true, music: { permission: true, license: 'licensed', provenance: '' } } },
  ]) assert.equal(storySettingsSchema.safeParse({ ...valid, ...change }).success, false);
  for (const speed of [0.75, 1.5]) assert.equal(storySettingsSchema.safeParse({ ...valid, speed }).success, true);
  const script = '“Hello!”\n\n世界 — café.';
  assert.equal(storySettingsSchema.parse({ ...valid, script }).script, script);
});
