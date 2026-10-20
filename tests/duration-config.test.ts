import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function readConfig(overrides: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', "import { config } from './src/server/config.ts'; console.log(JSON.stringify({ minimum: config.clipMinDuration, mode: config.durationMode, count: config.clipCount }));"], { encoding: 'utf8', env: { ...process.env, CLIP_MIN_DURATION: '30', CLIP_DURATION_MODE: 'auto', CLIP_COUNT: '5', HIGHLIGHT_COUNT: '8', DURATION_MODE: 'fixed', CLIP_MAX_DURATION: '60', ...overrides } });
}
test('CLIP settings take precedence over aliases and legacy maximums do not constrain analysis', () => {
  const result = readConfig(); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { minimum: 30, mode: 'auto', count: 5 });
});
test('configuration refuses shorter minima and fixed duration modes', () => {
  assert.notEqual(readConfig({ CLIP_MIN_DURATION: '15' }).status, 0);
  assert.notEqual(readConfig({ CLIP_DURATION_MODE: 'fixed' }).status, 0);
});
