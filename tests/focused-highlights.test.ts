import test from 'node:test';
import assert from 'node:assert/strict';
import * as analysis from '../src/server/analysis.js';
import { analysisSettingsSchema } from '../src/shared/validation.js';
import type { CandidateContext } from '../src/server/analysis.js';
import type { Highlight } from '../src/shared/types.js';

test('focused analysis defaults to eight and maps legacy all requests to the new cap', () => {
  assert.equal(analysisSettingsSchema.parse({}).clipCount, 8);
  assert.equal(analysisSettingsSchema.parse({ clipCount: 'all' }).clipCount, 8);
  assert.equal(analysisSettingsSchema.parse({ clipCount: 5 }).clipCount, 5);
  assert.equal(analysisSettingsSchema.safeParse({ clipCount: 9 }).success, false);
});

test('default selection keeps at most eight strong moments without filling missing slots', () => {
  const rows: Highlight[] = Array.from({ length: 30 }, (_, i) => ({ id: String(i), start: i * 20, end: i * 20 + 15, score: 99 - i, title: 'Complete moment', explanation: 'Setup and conclusion.', heuristicScore: 0, evidence: [], transcript: '', frameTimes: [] }));
  assert.equal(analysis.selectBestHighlights(rows).length, 8);
  assert.deepEqual(analysis.selectBestHighlights(rows, 5, 98).map(h => h.id), ['0', '1']);
});

test('shortlisting bounds model work, spans the timeline and favors local reaction evidence', () => {
  let materialized = 0;
  const contexts: CandidateContext[] = Array.from({ length: 2400 }, (_, i) => ({ id: String(i), start: i * 10, end: i * 10 + 190, cueCount: 20, priority: i % 100 === 50 ? 10 : 0, materialize: () => { materialized++; throw new Error('Shortlisting must not materialize inference text.'); } }));
  assert.equal(typeof analysis.shortlistContexts, 'function');
  const selected = analysis.shortlistContexts(contexts, 24);
  assert.equal(selected.length, 24); assert.equal(materialized, 0);
  assert.equal(selected[0]?.id, '0'); assert.equal(selected.at(-1)?.id, '2399');
  assert.equal(new Set(selected.map(c => c.id)).size, 24);
  assert.ok(selected.some(c => c.priority === 10));
  assert.ok(selected.every((c, i) => !i || c.start > selected[i - 1]!.start));
  assert.equal(analysis.shortlistContexts(contexts.slice(0, 3), 24).length, 3);
});
