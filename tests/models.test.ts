import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRankings, rankBatch } from '../src/server/models.js';
import type { Candidate } from '../src/shared/types.js';
const candidates: Candidate[] = [{ id: 'a', start: 0, end: 45, heuristicScore: 5, evidence: [], transcript: 'hello', frameTimes: [5] }];
test('model ranking accepts known IDs but cannot invent timestamps or change evidence', () => {
  const result = validateRankings({ rankings: [{ id: 'a', score: 70, title: 'Hello', explanation: 'A complete scene', start: -100 }] }, candidates);
  assert.equal(result[0]?.start, 0); assert.equal(result[0]?.heuristicScore, 5);
});
test('model ranking rejects missing, repeated or invented IDs and non-finite scores', () => {
  for (const rankings of [[], [{ id: 'unknown', score: 60, title: 'x', explanation: 'x' }], [{ id: 'a', score: Infinity, title: 'x', explanation: 'x' }], [1, 2].map(() => ({ id: 'a', score: 70, title: 'x', explanation: 'x' }))]) assert.throws(() => validateRankings({ rankings }, candidates));
});
test('Ollama structured output constrains exact video-segment IDs and ranking count', async t => {
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body)) as { format: { properties: { rankings: { minItems: number; maxItems: number; items: { properties: { id: { enum: string[] } } } } } }; messages: { content: string }[] };
    const shape = payload.format.properties.rankings;
    assert.deepEqual(shape.items.properties.id.enum, ['a']); assert.equal(shape.minItems, 1); assert.equal(shape.maxItems, 1);
    assert.match(payload.messages.map(m => m.content).join(' '), /video segments/i);
    return Response.json({ message: { content: JSON.stringify({ rankings: [{ id: 'a', score: 50, title: 'A greeting', explanation: 'Only a greeting is evidenced.' }] }) } });
  });
  assert.equal((await rankBatch(candidates, []))[0]?.id, 'a');
});

test('transcript inference returns model-selected natural boundaries rather than the context window', async t => {
  const context = { ...candidates[0]!, end: 180, cues: [{ start: 0, end: 12, text: 'Setup' }, { start: 12, end: 85, text: 'Payoff' }, { start: 85, end: 180, text: 'Next topic' }] };
  t.mock.method(globalThis, 'fetch', async () => Response.json({ message: { content: JSON.stringify({ rankings: [{ id: 'a', start: 0, end: 85, score: 90, title: 'Complete moment', explanation: 'Includes the setup and payoff.' }] }) } }));
  const result = await rankBatch([context], [], { transcriptOnly: true });
  assert.equal(result[0]?.start, 0); assert.equal(result[0]?.end, 85);
  assert.equal(result[0]?.transcript, 'Setup Payoff');
});

test('transcript inference rejects missing, invented and out-of-context boundaries', async t => {
  const context = { ...candidates[0]!, end: 85, cues: [{ start: 0, end: 12.5, text: 'Setup' }, { start: 12.5, end: 85, text: 'Payoff' }] };
  let timing: Record<string, number> = {};
  t.mock.method(globalThis, 'fetch', async () => Response.json({ message: { content: JSON.stringify({ rankings: [{ id: 'a', score: 90, title: 'Moment', explanation: 'Setup and payoff.', ...timing }] }) } }));
  for (const range of [{}, { start: 1, end: 85 }, { start: 0, end: 100 }, { start: 12.5, end: 12.5 }]) {
    timing = range; await assert.rejects(rankBatch([context], [], { transcriptOnly: true }));
  }
});

test('recording inference accepts Ollama-chosen short and long ranges and restores supplied evidence', async t => {
  const contexts: Candidate[] = [
    { id: 'short', start: 0, end: 200, heuristicScore: 10, transcript: 'Setup. Reaction. Next topic.', evidence: ['Scene change at 2s'], frameTimes: [0, 100], cues: [{ start: 0, end: 12, text: 'Setup. Reaction.' }, { start: 12, end: 200, text: 'Next topic.' }] },
    { id: 'long', start: 200, end: 500, heuristicScore: 10, transcript: 'Complete story. Next topic.', evidence: [], frameTimes: [200, 350], cues: [{ start: 200, end: 390, text: 'Complete story.' }, { start: 390, end: 500, text: 'Next topic.' }] },
  ];
  t.mock.method(globalThis, 'fetch', async () => Response.json({ message: { content: JSON.stringify({ rankings: [
    { id: 'short', start: 0, end: 12, score: 95, title: 'Reaction', explanation: 'The reaction completes here.', transcript: 'fabricated' },
    { id: 'long', start: 200, end: 390, score: 90, title: 'Complete story', explanation: 'The payoff needs the full setup.' },
  ] }) } }));
  const highlights = await rankBatch(contexts, [], { chooseRanges: true });
  assert.deepEqual(highlights.map(h => [h.start, h.end]), [[0, 12], [200, 390]]);
  assert.equal(highlights[0]?.transcript, 'Setup. Reaction.');
  assert.deepEqual(highlights[0]?.evidence, ['Scene change at 2s']);
});

test('recording inference rejects invalid model-selected intervals instead of silently restoring fixed windows', async t => {
  let range: Record<string, number> = {};
  t.mock.method(globalThis, 'fetch', async () => Response.json({ message: { content: JSON.stringify({ rankings: [{ id: 'a', score: 80, title: 'Moment', explanation: 'Evidence.', ...range }] }) } }));
  for (const timing of [{}, { start: -1, end: 12 }, { start: 0, end: 200 }, { start: 12, end: 12 }]) {
    range = timing; await assert.rejects(rankBatch(candidates, [], { chooseRanges: true }));
  }
});
