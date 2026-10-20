import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Word } from '../../shared/types.js';
import { config } from '../config.js';
import { runProcess } from '../process.js';
import { storyConfig } from './config.js';
const outputSchema=z.object({words:z.array(z.object({word:z.string().min(1),start:z.number().finite().nonnegative(),end:z.number().finite().positive(),probability:z.number().finite().min(0).max(1),supportedByRecognition:z.boolean().optional()}).refine(word=>word.end>word.start && (word.probability>=0.01 || word.supportedByRecognition===true))).min(1)});
export async function forceAlignNarrationChunk(wavFile: string, script: string, recognized: Word[], directory: string, signal: AbortSignal, language: string, command={executable:storyConfig.python,prefix:[fileURLToPath(new URL('./forced-align.py',import.meta.url))]}): Promise<Word[]> {
  signal.throwIfAborted(); await mkdir(directory,{recursive:true}); const input=path.join(directory,'forced-input.json');const output=path.join(directory,'forced-output.json');
  await writeFile(input,JSON.stringify({wavFile,script,recognized}),'utf8');
  const env={...process.env}; const pathKey=Object.keys(env).find(key=>key.toLowerCase()==='path')||'PATH';env[pathKey]=path.dirname(config.ffmpeg)+path.delimiter+(env[pathKey]||'');
  await runProcess(command.executable,[...command.prefix,'--input',input,'--output',output,'--model',config.whisperModel,'--language',language],{signal,env,timeout:config.whisperTimeout});
  signal.throwIfAborted();return outputSchema.parse(JSON.parse(await readFile(output,'utf8'))).words.map(({word,start,end})=>({word,start,end}));
}
