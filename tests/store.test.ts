import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import type { PathLike } from 'node:fs';
import { readJson, writeJson } from '../src/server/store.js';

test('atomic cache saves retry temporary Windows file locks without losing the previous result', async t => {
  const file = path.resolve('test-artifacts', `store-${randomUUID()}`, 'ranking.json');
  await writeJson(file, { accepted: 1 }); const rename = fs.rename; let attempts = 0;
  t.mock.method(fs, 'rename', async (from: PathLike, to: PathLike) => {
    attempts++;
    if (attempts <= 2) {
      assert.deepEqual(await readJson(file), { accepted: 1 });
      throw Object.assign(new Error('File temporarily locked'), { code: attempts === 1 ? 'EPERM' : 'EBUSY' });
    }
    await rename(from, to);
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await writeJson(file, { accepted: 2 });
  assert.deepEqual(await readJson(file), { accepted: 2 }); assert.equal(attempts, 3);
});

test('atomic cache saves stop after bounded file-lock retries', async t => {
  const file = path.resolve('test-artifacts', `store-${randomUUID()}`, 'ranking.json');
  await writeJson(file, { accepted: 1 }); let attempts = 0;
  t.mock.method(fs, 'rename', async () => { attempts++; throw Object.assign(new Error('File locked'), { code: 'EPERM' }); });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(writeJson(file, { accepted: 2 }), /locked/);
  assert.equal(attempts, 4); assert.deepEqual(await readJson(file), { accepted: 1 });
});
