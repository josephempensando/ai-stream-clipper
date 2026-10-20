import test from 'node:test';
import assert from 'node:assert/strict';
import { alignScript, alignNarration } from '../src/server/story/alignment.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { config } from '../src/server/config.js';
import { storySettingsSchema } from '../src/shared/story.js';
test('caption alignment preserves repeated original words and rejects missing speech', () => {
  const words = ['Go', 'go', 'now'].map((word, i) => ({ word, start: i * 0.5, end: (i + 1) * 0.5 }));
  assert.equal(alignScript('Go, go now.', words, 2).coverage, 1);
  assert.throws(() => alignScript('Go, go now.', words.slice(1), 2), /align|review/i);
  assert.throws(() => alignScript('Go, go now.', words.slice(1), 2), /near.*go/i);
  assert.throws(() => alignScript('Go', [{ word: 'Go', start: 2, end: 1 }], 3), /timestamp|align/i);
  assert.equal(alignScript("Don't count 42.", ['do', 'not', 'count', 'forty', 'two'].map((word, i) => ({ word, start: i, end: i + 0.8 })), 5).coverage, 1);
  assert.equal(alignScript('forty two', [{ word: '42', start: 0, end: 1 }], 2).segments[0]!.words!.length, 1);
});
test('clock formatting and ordinary contractions retain original caption spelling', () => {
  const words = ['At', '307am,', "you'll", 'hear', 'three', 'knocks.'].map((word, i) => ({ word, start: i, end: i + 0.8 }));
  const aligned = alignScript("At 3:07 AM, you'll hear three knocks.", words, 6);
  assert.equal(aligned.coverage, 1); assert.equal(aligned.segments.flatMap(s => s.words!).map(w => w.word).join(' '), "At 3:07 AM, you'll hear three knocks.");
  assert.throws(() => alignScript("At 3:17 AM, you'll hear three knocks.", words, 6), /alignment/i);
  const expanded = ['You', 'will', 'hear', 'it.'].map((word, i) => ({ word, start: i, end: i + 0.8 }));
  assert.equal(alignScript("You'll hear it.", expanded, 4).coverage, 1);
  assert.equal(alignScript('At 3:07 AM.', [{ word: 'At', start: 0, end: 0.2 }, { word: '3', start: 0.3, end: 0.5 }, { word: '.07am.', start: 0.5, end: 1 }], 2).coverage, 1);
});
test('retry gives Whisper source-name hints with independent deterministic windows, never the whole narrative as a continuation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'story-retry-')); const original = config.whisper; config.whisper = process.execPath;
  const file = path.join(directory, 'speech.cjs');
  await writeFile(file, `const fs=require('fs'),path=require('path'); const args=process.argv;const hinted=args.includes('--initial_prompt');const value=k=>args[args.indexOf(k)+1];if(hinted && (value('--initial_prompt')!=='Reyes.'||value('--condition_on_previous_text')!=='False'||value('--carry_initial_prompt')!=='True'||value('--temperature_increment_on_fallback')!=='None'))process.exit(2);const text=hinted?['At','3','.07am,','Mrs.','Reyes','called.']:['At','307am,','Mrs.','Rais','called.'];fs.writeFileSync(path.join(value('--output_dir'),'speech.cjs.json'),JSON.stringify({segments:[{start:0,end:6,text:text.join(' '),words:text.map((word,i)=>({start:i,end:i+0.8,word}))}]}));`);
  try {
    const settings = storySettingsSchema.parse({ script: 'At 3:07 AM, Mrs. Reyes called.', voiceId: 'test', rights: { footagePermission: true } });
    const aligned = await alignNarration({ wavFile: file, duration: 6, chunks: [{ index: 0, text: settings.script, startOffset: 0, endOffset: settings.script.length, paragraphEnd: true, wavFile: file, offset: 0, duration: 6 }] }, settings, directory, new AbortController().signal, async () => {}, 'en', async () => { throw new Error('Fixture alignment unavailable'); });
    assert.equal(aligned.coverage, 1); assert.equal(aligned.segments.flatMap(s => s.words!).map(w => w.word).join(' '), settings.script);
  } finally { config.whisper = original; await rm(directory, { recursive: true, force: true }); }
});
test('known narration refines ASR substitutions with real aligner spans, without fabricating missing word timing', async () => {
  const directory=await mkdtemp(path.join(os.tmpdir(),'story-refine-')); const original=config.whisper;config.whisper=process.execPath;const file=path.join(directory,'speech.cjs');
  await writeFile(file,`const fs=require('fs'),path=require('path');fs.writeFileSync(path.join(process.argv[process.argv.indexOf('--output_dir')+1],'speech.cjs.json'),JSON.stringify({segments:[{start:0,end:2,text:'Someone knock twice.',words:[{word:'Someone',start:0,end:0.5},{word:'knock',start:0.6,end:1},{word:'twice.',start:1.2,end:1.8}]}]}));`);
  try{
    const settings=storySettingsSchema.parse({script:'Someone knocked twice.',voiceId:'test',rights:{footagePermission:true}});const narration={wavFile:file,duration:2,chunks:[{index:0,text:settings.script,startOffset:0,endOffset:settings.script.length,paragraphEnd:true,wavFile:file,offset:0,duration:2}]};
    const aligned=await alignNarration(narration,settings,directory,new AbortController().signal,async()=>{},'en',async (_wav,script)=>{assert.equal(script,settings.script);return [{word:'Someone',start:0,end:0.5},{word:'knocked',start:0.6,end:1},{word:'twice.',start:1.2,end:1.8}];});
    assert.equal(aligned.coverage,1);assert.equal(aligned.segments[0]!.words![1]!.word,'knocked');assert.equal(aligned.segments[0]!.words![1]!.start,0.6);assert.match(aligned.warnings.join(' '),/audio/i);
    await assert.rejects(alignNarration(narration,settings,directory,new AbortController().signal,async()=>{},'en',async()=>[{word:'Someone',start:0,end:0.5},{word:'twice.',start:1.2,end:1.8}]),/chunk 1.*near/i);
  }finally{config.whisper=original;await rm(directory,{recursive:true,force:true});}
});
test('story caption transcription uses its voice language and measured chunk offset', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'story-language-')); const original = config.whisper; const originalLanguage = config.whisperLanguage;
  config.whisper = process.execPath; config.whisperLanguage = 'en'; const file = path.join(directory, 'speech.cjs');
  await writeFile(file, `const fs=require('fs'),path=require('path'); if(process.argv[process.argv.indexOf('--language')+1]!=='es') process.exit(2); const output=process.argv[process.argv.indexOf('--output_dir')+1]; fs.writeFileSync(path.join(output,'speech.cjs.json'),JSON.stringify({segments:[{start:0,end:1,text:'Hola.',words:[{start:0,end:1,word:'Hola.'}]}]}));`);
  try {
    const settings = storySettingsSchema.parse({ script: 'Hola.', voiceId: 'es-voice', rights: { footagePermission: true } });
    const result = await alignNarration({ wavFile: file, duration: 3, chunks: [{ index: 0, text: 'Hola.', startOffset: 0, endOffset: 5, paragraphEnd: true, wavFile: file, offset: 1.25, duration: 1.5 }] }, settings, directory, new AbortController().signal, async () => {}, 'es');
    assert.equal(result.segments[0]!.start, 1.25); assert.equal(result.segments[0]!.end, 2.25);
  } finally { config.whisper = original; config.whisperLanguage = originalLanguage; await rm(directory, { recursive: true, force: true }); }
});
