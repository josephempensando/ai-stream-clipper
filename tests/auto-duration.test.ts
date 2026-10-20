import test from 'node:test';
import assert from 'node:assert/strict';
import { rankBatch } from '../src/server/models.js';
import type { RankSettings } from '../src/server/models.js';
import type { Candidate, Segment } from '../src/shared/types.js';
import { renderSchema, validateEdits } from '../src/shared/validation.js';
import { highlightDetails } from '../src/shared/highlights.js';

const settings = { chooseRanges: true, durationMode: 'auto' } as RankSettings;
function context(cues: Segment[], duration = cues.at(-1)!.end): Candidate {
  return { id: 'story', start: 0, end: duration, heuristicScore: 20, evidence: [], transcript: cues.map(c => c.text).join(' '), frameTimes: [0], cues };
}
const row = { start: 0, end: 15, score: 90, title: 'Complete moment', description: 'A source-grounded account of the moment.', explanation: 'Includes the complete setup and conclusion.' };

test('auto inference preserves meaningful context, whole Q&A, long explanations and recording edges', async t => {
  const examples = [
    [{ start: 0, end: 20, text: 'Here is the difficult problem.' }, { start: 20, end: 30, text: 'Wow! I finally solved it!' }],
    [{ start: 0, end: 12, text: 'Why does the sky change color?' }, { start: 12, end: 95, text: 'Here is the full answer and its conclusion.' }],
    [{ start: 0, end: 20, text: 'Let me explain the problem.' }, { start: 20, end: 160, text: 'The detailed reasoning follows.' }, { start: 160, end: 205.5, text: 'That is why the result matters.' }],
    [{ start: 270, end: 300, text: 'And that completes the story.' }],
  ];
  let source = context(examples[0]!);
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body));
    const prompt = payload.messages.map((m: { content: string }) => m.content).join(' ');
    assert.doesNotMatch(prompt, /30.{1,3}60/);
    assert.match(prompt, /question.*answer|Q&A/i);
    assert.match(prompt, /meaning|misrepresent/i);
    const shape = payload.format.properties.rankings.properties.story.anyOf.find((entry: { type: string }) => entry.type === 'object');
    assert.deepEqual(shape.properties.start.enum || [shape.properties.start.const], source.cues!.map(c => c.start));
    assert.deepEqual(shape.properties.end.enum || [shape.properties.end.const], source.cues!.map(c => c.end));
    return Response.json({ message: { content: JSON.stringify({ rankings: { story: { ...row, start: source.cues![0]!.start, end: source.cues!.at(-1)!.end } } }) } });
  });
  for (const cues of examples) {
    source = context(cues);
    const [highlight] = await rankBatch([source], [], settings);
    assert.ok(highlight);
    assert.equal(highlight.start, cues[0]!.start);
    assert.equal(highlight.end, cues.at(-1)!.end);
    assert.equal(highlight.transcript, cues.map(c => c.text).join(' '));
    assert.equal((highlight as unknown as { duration: number }).duration, highlight.end - highlight.start);
    assert.equal((highlight as unknown as { engagementScore: number }).engagementScore, 90);
    assert.equal((highlight as unknown as { description: string }).description, row.description);
  }
});

test('auto validation rejects fabricated times, reversed ranges, out-of-video times and long silent gaps', async t => {
  const source = context([{ start: 0, end: 15, text: 'A complete reaction.' }, { start: 40, end: 205, text: 'A separate explanation.' }]);
  let timing = { start: 0, end: 15 };
  t.mock.method(globalThis, 'fetch', async () => Response.json({ message: { content: JSON.stringify({ rankings: { story: { ...row, ...timing } } }) } }));
  for (timing of [{ start: 1, end: 15 }, { start: 0, end: 14 }, { start: 40, end: 15 }, { start: 40, end: 206 }, { start: 0, end: 205 }]) {
    await assert.rejects(rankBatch([source], [], settings));
  }
});

test('auto inference can decline a context without fabricating a clip', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ message: { content: JSON.stringify({ rankings: { story: null } }) } }));
  assert.deepEqual(await rankBatch([context([{ start: 0, end: 5, text: 'Unrelated fragment.' }])], [], settings), []);
});

test('configurable clip count supports rendering more than five varied non-overlapping drafts', () => {
  const clips = Array.from({ length: 7 }, (_, i) => ({ id: String(i), start: i * 250, end: i * 250 + (i % 2 ? 205 : 30) }));
  assert.doesNotThrow(() => validateEdits(clips, 1800));
  assert.equal(renderSchema.parse({ clips, options: { layout: 'blur', cropX: 0.5, subtitles: false } }).clips.length, 7);
});

test('edited timing metadata is recomputed from the actual interval', () => {
  const original = highlightDetails({ ...context([{ start: 0, end: 205, text: 'Complete story.' }]), ...row, end: 205 });
  const edited = highlightDetails({ ...original, start: 15, end: 195 });
  assert.equal(edited.startTime, 15); assert.equal(edited.endTime, 195); assert.equal(edited.duration, 180);
  assert.equal(edited.reasonForSelection, row.explanation); assert.equal(edited.engagementScore, 90);
});
