import test from 'node:test';
import assert from 'node:assert/strict';
import { PiperSynthesizer, piperArgs } from '../src/server/story/piper.js';
import { probeAudio } from '../src/server/story/audio.js';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('Piper uses files and inverse speed, never interpolating speech into commands', async () => {
  const voice = { id: 'test', label: 'Test', language: 'en', installed: true, licenseUrl: 'https://example.com', modelPath: 'voice.onnx', configPath: 'voice.onnx.json' };
  const args = piperArgs({ textFile: 'story.txt', wavFile: 'out.wav', voice, speed: 1.5 });
  assert.equal(Number(args[args.indexOf('--length-scale') + 1]), 1 / 1.5);
  assert.ok(args.includes('--input-file') && args.includes('--output-file'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(new PiperSynthesizer().synthesize({ textFile: 'missing', wavFile: 'missing', voice, speed: 1 }, controller.signal), /abort/i);
  await assert.rejects(probeAudio('missing-audio.wav'), /audio|ffprobe|file/i);
});
test('Piper adapter validates real child output and keeps shell-like UTF-8 speech inert', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'piper-fixture-')); const textFile = path.join(root, 'text.txt'); const wavFile = path.join(root, 'output.wav');
  const text = '“Hello.” $(touch secret) & echo nope\nExact text.'; await writeFile(textFile, text, 'utf8');
  const adapter = new PiperSynthesizer({ executable: process.execPath, prefix: [path.resolve('tests/fixtures/story/piper-child.cjs')] });
  const voice = { id: 'test', label: 'Test', language: 'en', installed: true, licenseUrl: 'https://example.com', modelPath: 'good', configPath: 'good.json' };
  try {
    const signal = new AbortController().signal; await adapter.synthesize({ textFile, wavFile, voice, speed: 1.5 }, signal); assert.equal((await probeAudio(wavFile)).duration, 0.25);
    const observed = JSON.parse(await readFile(path.join(root, 'observed.json'), 'utf8')); assert.equal(observed.text, text); assert.equal(observed.args.includes(text), false);
    for (const mode of ['missing', 'empty', 'corrupt', 'fail']) { await rm(wavFile, { force: true }); await assert.rejects(adapter.synthesize({ textFile, wavFile, voice: { ...voice, modelPath: mode }, speed: 1 }, signal), /Piper narration failed/i); }
    const controller = new AbortController(); const running = adapter.synthesize({ textFile, wavFile, voice: { ...voice, modelPath: 'slow' }, speed: 1 }, controller.signal);
    for (let i = 0; i < 100; i++) { try { await readFile(path.join(root, 'pid.txt')); break; } catch { await new Promise(r => setTimeout(r, 10)); } }
    const pid = Number(await readFile(path.join(root, 'pid.txt'), 'utf8')); controller.abort(); await assert.rejects(running, /abort/i); assert.throws(() => process.kill(pid, 0));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('childlike preset changes actual audio pitch while preserving speaking duration', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'piper-pitch-'));
  try {
    const fixture=path.join(root,'piper.cjs');
    await writeFile(fixture,(await readFile('tests/fixtures/story/piper-child.cjs','utf8')).replace('count = 12000','count = 96000'));
    const textFile=path.join(root,'story.txt'),wavFile=path.join(root,'voice.wav');await writeFile(textFile,'A small story.');
    const voice={id:'childlike',label:'Childlike',language:'en',installed:true,licenseUrl:'https://example.test/license',modelPath:'good',configPath:'good.json',pitchSemitones:3};
    await new PiperSynthesizer({executable:process.execPath,prefix:[fixture]}).synthesize({textFile,wavFile,voice,speed:1},new AbortController().signal);
    assert.ok(Math.abs((await probeAudio(wavFile)).duration-2)<0.1);
    // Decode a stable interior second; frequency must change, not just labels.
    const decoded=path.join(root,'decoded.wav');
    const {ffmpeg}=await import('../src/server/media.js');await ffmpeg(['-i',wavFile,'-ss','0.3','-t','1','-ac','1','-ar','48000','-c:a','pcm_s16le',decoded]);
    const data=await readFile(decoded);const marker=data.indexOf(Buffer.from('data'));const samples=data.subarray(marker+8);let crossings=0;
    for(let i=2;i<samples.length;i+=2)if(samples.readInt16LE(i-2)<=0&&samples.readInt16LE(i)>0)crossings++;
    assert.ok(crossings>500&&crossings<550,`Expected raised 440 Hz tone; measured ${crossings} Hz`);
  } finally {await rm(root,{recursive:true,force:true});}
});
