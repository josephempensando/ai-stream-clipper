import test from 'node:test';
import assert from 'node:assert/strict';
import { offsetSegments, buildCandidates, selectHighlights, selectBestHighlights } from '../src/server/analysis.js';
import { createSrt } from '../src/server/subtitles.js';
import type { Highlight } from '../src/shared/types.js';

test('Whisper chunk offsets preserve absolute recording times and clamp boundaries', () => {
  assert.deepEqual(offsetSegments([{ start: 2, end: 9, text: ' hello ' }, { start: 11, end: 12, text: 'past end' }], 600, 610), [{ start: 602, end: 609, text: 'hello' }]);
});
test('recording candidates supply timestamped context instead of fixed clip windows', () => {
  const cues = [{ start: 10, end: 22, text: 'Wait what? No way! Haha!' }, { start: 22, end: 260, text: 'A complete longer story and payoff.' }];
  const candidates = buildCandidates(cues, [{ time: 11, loudness: -4, scene: true }], 300);
  assert.ok(candidates.length > 0);
  for (const c of candidates) { assert.ok(c.start >= 0 && c.end <= 300); assert.ok(c.frameTimes.every(t => t >= c.start && t < c.end)); }
  assert.ok(candidates.some(c => c.end - c.start > 180 && c.cues?.length === 2));
  assert.ok(candidates.some(c => c.transcript.includes('No way')));
  assert.ok(candidates.some(c => c.evidence.some(e => /scene/i.test(e))));
  assert.ok(buildCandidates([{ start: 0, end: 10, text: 'A short complete moment.' }], [], 10).length > 0);
  assert.deepEqual(buildCandidates([], [], 29), []);
});
test('ranking selector returns five non-overlapping windows and does not pad missing results', () => {
  const clips = Array.from({ length: 8 }, (_, i): Highlight => ({ id: String(i), start: i * 35, end: i * 35 + 30, heuristicScore: 10, score: 90 - i, title: 'Moment', explanation: 'Context', evidence: [], transcript: '', frameTimes: [] }));
  const result = selectHighlights([...clips, { ...clips[0]!, id: 'overlap', start: 1, end: 31, score: 100 }]);
  assert.equal(result.length, 5);
  for (const a of result) for (const b of result) if (a !== b) assert.ok(a.end <= b.start || b.end <= a.start);
  assert.equal(selectHighlights([clips[0]!]).length, 1);
});
test('subtitles rebase clip times and intersect segments crossing trim boundaries', () => {
  const srt = createSrt([{ start: 28, end: 33, text: 'hello\nworld' }, { start: 58, end: 65, text: 'finish' }, { start: 70, end: 75, text: 'outside' }], 30, 60);
  assert.match(srt, /00:00:00,000 --> 00:00:03,000/);
  assert.match(srt, /00:00:28,000 --> 00:00:30,000/);
  assert.ok(!srt.includes('outside'));
});
test('selection finds five feasible clips even when one highly ranked middle window blocks two', () => {
  const base = { heuristicScore: 1, title: 'Moment', explanation: 'Context', evidence: [], transcript: '', frameTimes: [] };
  const clips: Highlight[] = Array.from({ length: 5 }, (_, i) => ({ ...base, id: String(i), start: i * 45, end: i * 45 + 45, score: 70 }));
  clips.push({ ...base, id: 'middle', start: 20, end: 65, score: 100 });
  assert.equal(selectHighlights(clips).length, 5);
});

test('natural-range selection keeps the strongest complete story instead of favoring five shorter clips', () => {
  const base = { heuristicScore: 1, title: 'Moment', explanation: 'Context', evidence: [], transcript: '', frameTimes: [] };
  const story = { ...base, id: 'story', start: 0, end: 190, score: 99 };
  const shorter = Array.from({ length: 5 }, (_, i) => ({ ...base, id: String(i), start: i * 35, end: i * 35 + 12, score: 10 }));
  assert.deepEqual(selectBestHighlights([...shorter, story]), [story]);
});
