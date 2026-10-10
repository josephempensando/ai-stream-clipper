import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { config } from '../src/server/config.js';
import { transcribeChunk } from '../src/server/models.js';

test('Whisper receives the configured FFmpeg directory without changing the parent environment', async t => {
  const root = path.resolve('test-artifacts', `whisper-path-${randomUUID()}`); await mkdir(root, { recursive: true });
  const script = path.join(root, 'speech.cjs'); const original = config.whisper; const originalPath = process.env.PATH;
  t.after(() => { config.whisper = original; });
  config.whisper = process.execPath;
  // Node stands in for the external CLI, retaining real child process execution.
  await writeFile(script, `const fs = require('node:fs'); const path = require('node:path');
const expected = ${JSON.stringify(path.dirname(config.ffmpeg))};
if (!(process.env.PATH || '').split(path.delimiter).includes(expected)) { console.error('Configured FFmpeg is missing from the child PATH'); process.exit(2); }
const output = process.argv[process.argv.indexOf('--output_dir') + 1];
fs.writeFileSync(path.join(output, 'speech.cjs.json'), JSON.stringify({segments:[{start:0,end:3,text:'Original test speech.'}]}));`);
  const segments = await transcribeChunk(script, root);
  assert.deepEqual(segments, [{ start: 0, end: 3, text: 'Original test speech.' }]);
  assert.equal(process.env.PATH, originalPath);
});
