import test from 'node:test';
import assert from 'node:assert/strict';
import { planBackground } from '../src/server/story/background.js';
test('background fitting follows the actual narration duration', () => {
  assert.equal(planBackground(12, 5, 'auto').mode, 'trim');
  assert.equal(planBackground(9, 12, 'auto').playbackRate, 0.75);
  assert.equal(planBackground(5, 30, 'auto').mode, 'loop');
  assert.equal(planBackground(5, 30, 'slow-loop').playbackRate, 0.75);
  assert.ok(planBackground(0.5, 2.01, 'loop').dissolveSeconds > 0);
});
