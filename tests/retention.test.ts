import test from 'node:test';
import assert from 'node:assert/strict';
import { validateNarrative, buildEdl, analyzeNarrative } from '../src/server/retention.js';
import { retentionSettingsSchema } from '../src/shared/retention.js';
import { offsetSegments } from '../src/server/analysis.js';
import { createAss, alignedWords } from '../src/server/retention-captions.js';
import type { Highlight, Segment } from '../src/shared/types.js';

const cues: Segment[] = [
  { start: 10, end: 12, text: 'Why did it fail?', words: [{ start: 10, end: 10.4, word: 'Why' }, { start: 10.5, end: 10.8, word: 'did' }, { start: 11, end: 11.2, word: 'it' }, { start: 11.3, end: 12, word: 'fail?' }] },
  { start: 14, end: 18, text: 'We checked the cable.' },
  { start: 18, end: 22, text: 'Then we found a loose connector!' },
  { start: 22, end: 25, text: 'Tightening it fixed the problem.' },
];
const highlight: Highlight = { id: 'story', start: 10, end: 25, cues, transcript: cues.map(c => c.text).join(' '), frameTimes: [], evidence: [], heuristicScore: 0, score: 80, title: 'Cable repair', explanation: 'Source explanation.' };
const raw = { hook: { first: 0, last: 0 }, setup: { first: 1, last: 1 }, escalation: { first: 2, last: 2 }, payoff: { first: 3, last: 3 }, ending: { first: 3, last: 3 }, reason: 'Question answered by the actual repair.', loop: false, loopReason: 'The answer ends the explanation.', emphasis: [2], pauseCuts: [0] };
const settings = retentionSettingsSchema.parse({ autoEdit: true });

test('narrative references derive quotes and reject invented or out-of-order evidence', () => {
  const narrative = validateNarrative(raw, highlight);
  assert.equal(narrative.beats.hook?.quote, 'Why did it fail?');
  assert.equal(narrative.beats.payoff?.start, 22);
  assert.equal(narrative.coherent, true);
  assert.throws(() => validateNarrative({ ...raw, hook: { first: 9, last: 9 } }, highlight));
  assert.throws(() => validateNarrative({ ...raw, payoff: { first: 0, last: 0 } }, highlight));
  assert.equal(validateNarrative({ ...raw, payoff: null }, highlight).coherent, false);
});

test('natural durations preserve short reactions, podcast Q&A, long stories and low energy footage', () => {
  for (const [duration, text] of [[2, 'Wow! It worked!'], [95, 'Why? Here is the complete answer.'], [205, 'This is the whole story and its conclusion.'], [17, 'A quiet explanation.']] as const) {
    const h = { ...highlight, start: 0, end: duration, cues: [{ start: 0, end: duration, text }] };
    const n = validateNarrative({ ...raw, hook: { first: 0, last: 0 }, setup: null, escalation: null, payoff: { first: 0, last: 0 }, ending: { first: 0, last: 0 }, emphasis: [], pauseCuts: [] }, h);
    assert.equal(buildEdl(h, n, [], settings).duration, duration);
  }
});

test('EDL cuts approved silence only, retains pause handles and uses real scene/emphasis evidence', () => {
  const n = validateNarrative(raw, highlight);
  const edl = buildEdl(highlight, n, [{ time: 19, scene: true, loudness: -10 }], settings);
  assert.deepEqual(edl.keep, [{ start: 10, end: 12.25 }, { start: 13.75, end: 25 }]);
  assert.equal(edl.duration, 13.5);
  assert.ok(edl.actions.some(a => a.type === 'punch-in' && a.start === 18));
  assert.equal(buildEdl(highlight, n, [], { ...settings, patternInterrupts: false }).actions.some(a => a.type === 'punch-in'), false);
  assert.throws(() => buildEdl(highlight, n, [], { ...settings, ending: 'loop' }), /loop/i);
});

test('word timestamps survive chunk offsets; karaoke does not invent word alignment', () => {
  const [shifted] = offsetSegments([cues[0]!], 100, 120);
  assert.equal(shifted?.words?.[0]?.start, 110);
  const edl = buildEdl(highlight, validateNarrative(raw, highlight), [], settings);
  assert.equal(alignedWords(cues).length, 4);
  const ass = createAss(cues, edl, settings.captions, []);
  assert.match(ass, /\\kf40/);
  assert.match(ass, /fail\?/);
  assert.match(ass, /Tightening it fixed the problem\./);
  assert.doesNotMatch(ass, /\\kf0\}/);
});

test('Ollama narrative pass rejects unsupported references and reports real inference failures', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ message: { content: JSON.stringify({ ...raw, hook: { first: 99, last: 99 } }) } }));
  await assert.rejects(analyzeNarrative(highlight, 'auto'));
});

test('narrative inference retries invalid source references and constrains every generated cue index', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    const index = request.format.properties.emphasis.items;
    assert.deepEqual(index.enum, [0, 1, 2, 3]);
    calls++;
    return Response.json({ message: { content: JSON.stringify(calls === 1 ? { ...raw, emphasis: [99] } : raw) } });
  });
  assert.equal((await analyzeNarrative(highlight, 'verbal')).beats.hook?.quote, 'Why did it fail?');
  assert.equal(calls, 2);
});
