import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ffmpeg } from '../src/server/media.js';
import { analyzeRecording, type PipelineAdapters } from '../src/server/pipeline.js';
import type { Candidate, Highlight, Job } from '../src/shared/types.js';
import { OllamaRankingError } from '../src/server/models.js';

const highlight = (c: Candidate): Highlight => ({ ...c, start: c.cues![0]!.start, end: c.cues![0]!.start + 0.5, score: 90, title: 'Reaction', explanation: 'A supported complete reaction.' });
async function fixture() {
  const root = path.resolve('test-artifacts', `recovery-${randomUUID()}`); await mkdir(root, { recursive: true });
  const file = path.join(root, 'owned.mp4');
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=5:d=3', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', file]);
  const job: Job = { id: randomUUID(), name: 'owned.mp4', createdAt: new Date().toISOString(), status: 'analyzing', stage: 'Ranking', progress: 65, media: { duration: 3, width: 160, height: 90, hasAudio: true }, mediaHash: 'owned', source: 'upload', vodId: null, vodOffset: 0, highlights: [], outputs: [], warnings: [], error: null, renderOptions: null };
  return { root, file, job };
}
const speech = () => Promise.resolve([0, 1, 2].map(start => ({ start, end: start + 1, text: 'Wait! A complete reaction.' })));

test('duplicate IDs in a batch recover with isolated candidates and bounded retries', async () => {
  const f = await fixture(); const attempts = new Map<string, number>();
  const adapters: PipelineAdapters = { transcribe: speech, rank: async cs => {
    if (cs.length > 1) return cs.map(() => highlight(cs[0]!));
    const c = cs[0]!; const attempt = (attempts.get(c.id) || 0) + 1; attempts.set(c.id, attempt);
    return [{ ...highlight(c), id: attempt === 1 ? 'invented-id' : c.id }];
  } };
  const result = await analyzeRecording(f.job, f.file, f.root, async () => {}, adapters);
  assert.deepEqual(result.highlights.map(h => [h.start, h.end]), [[0, 0.5], [1, 1.5], [2, 2.5]]);
  assert.ok([...attempts.values()].every(count => count === 2));
  assert.ok(result.warnings.some(w => /retr|smaller|isolat/i.test(w)));
});

test('a persistently invalid context keeps valid highlights and retries only missing work on the next analysis', async () => {
  const f = await fixture(); let fail = true; let transcriptions = 0; const requested: string[][] = [];
  const adapters: PipelineAdapters = { transcribe: async () => { transcriptions++; return speech(); }, rank: async cs => {
    requested.push(cs.map(c => c.id));
    return cs.map(c => ({ ...highlight(c), id: fail && c.id === 'recording-context-1' ? 'invented' : c.id }));
  } };
  const partial = await analyzeRecording(f.job, f.file, f.root, async () => {}, adapters);
  assert.deepEqual(partial.highlights.map(h => h.id), ['recording-context-0', 'recording-context-2']);
  assert.ok(partial.warnings.some(w => /1.*context.*(skip|fail|analyz)/i.test(w)));
  fail = false; requested.length = 0;
  const recovered = await analyzeRecording(f.job, f.file, f.root, async () => {}, adapters);
  assert.equal(recovered.highlights.length, 3); assert.equal(transcriptions, 1);
  assert.deepEqual(requested, [['recording-context-1']]);
});

test('a model outage after successful recovery preserves saved highlights and stops further requests', async () => {
  const f = await fixture(); const isolated: string[] = [];
  const adapters: PipelineAdapters = { transcribe: speech, rank: async cs => {
    if (cs.length > 1) throw new OllamaRankingError('Invalid batched output.', 'invalid');
    const c = cs[0]!; isolated.push(c.id);
    if (c.id === 'recording-context-1') throw new OllamaRankingError('Ollama is unreachable.', 'unavailable', false);
    return [highlight(c)];
  } };
  const result = await analyzeRecording(f.job, f.file, f.root, async () => {}, adapters);
  assert.deepEqual(result.highlights.map(h => h.id), ['recording-context-0']);
  assert.deepEqual(isolated, ['recording-context-0', 'recording-context-1']);
  assert.ok(result.warnings.some(w => /unreachable/.test(w)));
});
