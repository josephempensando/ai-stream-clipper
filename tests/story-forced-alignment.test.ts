import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { forceAlignNarrationChunk } from '../src/server/story/forced-alignment.js';
test('forced alignment passes exact script in a private file and rejects unsupported confidence', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'story-forced-')); const fixture=path.join(root,'align.cjs');
  await writeFile(fixture, `const fs=require('fs');const args=process.argv;const input=JSON.parse(fs.readFileSync(args[args.indexOf('--input')+1],'utf8'));const probability=input.script==='Original.'?0.9:0.001;fs.writeFileSync(args[args.indexOf('--output')+1],JSON.stringify({words:[{word:input.script,start:0.1,end:0.8,probability,supportedByRecognition:input.script==='DO'}]}));`);
  try {
    const command={executable:process.execPath,prefix:[fixture]}; const signal=new AbortController().signal;
    const words=await forceAlignNarrationChunk('owned.wav','Original.',[],root,signal,'en',command); assert.equal(words[0]!.word,'Original.');
    const input=JSON.parse(await readFile(path.join(root,'forced-input.json'),'utf8')); assert.equal(input.script,'Original.');
    await assert.rejects(forceAlignNarrationChunk('owned.wav','Bad.',[],root,signal,'en',command));
    assert.equal((await forceAlignNarrationChunk('owned.wav','DO',[],root,signal,'en',command))[0]!.word,'DO');
  } finally { await rm(root,{recursive:true,force:true}); }
});
