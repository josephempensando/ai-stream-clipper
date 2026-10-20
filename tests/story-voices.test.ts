import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { loadVoiceCatalog } from '../src/server/story/voices.js';
import { runProcess } from '../src/server/process.js';

test('voice catalog exposes only permitted local models and checks adjacent configurations', async () => {
  const root = await mkdtemp(path.resolve('test-artifacts/voices-'));
  await mkdir(path.join(root, 'models'));
  await writeFile(path.join(root, 'models/a.onnx'), 'model fixture');
  await writeFile(path.join(root, 'models/a.onnx.json'), JSON.stringify({ audio: { sample_rate: 22050 }, language: { code: 'en-us' }, num_speakers: 1 }));
  const entries = [
    { id: 'voice-a', label: 'Voice A', language: 'en', licenseUrl: 'https://example.test/model-card', model: 'models/a.onnx', config: 'models/a.onnx.json', permitted: true },
    { id: 'voice-b', label: 'Voice B', language: 'en', licenseUrl: 'https://example.test/model-card', model: 'b.onnx', config: 'b.onnx.json', permitted: true },
  ];
  await writeFile(path.join(root, 'voices.json'), JSON.stringify({ voices: entries }));
  const voices = await loadVoiceCatalog(root);
  assert.equal(voices.length, 2); assert.equal(voices[0]?.installed, true); assert.equal(voices[1]?.installed, false);
  await writeFile(path.join(root, 'voices.json'), JSON.stringify({ voices: [{ ...entries[0], config: 'models/other.onnx.json' }] }));
  await assert.rejects(loadVoiceCatalog(root), /voice|configuration|registry/i);
  await writeFile(path.join(root, 'voices.json'), JSON.stringify({ voices: [{ ...entries[0], model: '../secret.onnx' }] }));
  await assert.rejects(loadVoiceCatalog(root), /voice|path|registry/i);
});
test('absent registry is a nonfatal setup state', async () => {
  assert.deepEqual(await loadVoiceCatalog(path.resolve('test-artifacts/no-such-voice-registry')), []);
});

test('setup adds working voice presets without replacing custom registry entries', async () => {
  const root=await mkdtemp(path.resolve('test-artifacts/voice-presets-'));
  try {
    await writeFile(path.join(root,'en_US-lessac-medium.onnx'),'fixture');
    await writeFile(path.join(root,'en_US-lessac-medium.onnx.json'),JSON.stringify({audio:{sample_rate:22050}}));
    const custom={id:'custom',label:'My custom voice',language:'en',licenseUrl:'https://example.test/license',model:'custom.onnx',config:'custom.onnx.json',permitted:true};
    await writeFile(path.join(root,'voices.json'),JSON.stringify({voices:[custom]}));
    await runProcess(process.execPath,['--import','tsx','scripts/setup-story-voice.ts'],{env:{...process.env,PIPER_VOICES_DIR:root}});
    const voices=await loadVoiceCatalog(root);
    assert.deepEqual(voices.find(v=>v.id==='custom')?.label,custom.label);
    assert.ok(voices.some(v=>v.label.startsWith('Man')));
    assert.ok(voices.some(v=>v.label.startsWith('Woman')));
    assert.ok(voices.some(v=>v.label.startsWith('Childlike')&&v.installed));
    const saved=JSON.parse(await readFile(path.join(root,'voices.json'),'utf8'));
    await runProcess(process.execPath,['--import','tsx','scripts/setup-story-voice.ts'],{env:{...process.env,PIPER_VOICES_DIR:root}});
    assert.deepEqual(JSON.parse(await readFile(path.join(root,'voices.json'),'utf8')),saved);
  } finally {await rm(root,{recursive:true,force:true});}
});
