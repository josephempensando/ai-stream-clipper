import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { writeJson } from '../src/server/store.js';
import { transcriptCandidates } from '../src/server/transcripts.js';
import { config } from '../src/server/config.js';
import { TwitchClient } from '../src/server/twitch.js';
import { YouTubeClient } from '../src/server/youtube.js';
import { TimestampAnalyzer } from '../src/server/timestamp-analyzer.js';
import type { Candidate, Highlight } from '../src/shared/types.js';

const vod = { id: '123', title: 'Variety stream', user_id: '42', user_name: 'CaseOh', duration: '2h', thumbnail_url: '', url: 'https://www.twitch.tv/videos/123', created_at: '2026-10-09T00:00:00Z', view_count: 1000 };
const clip = (id: string, offset: number | null, duration = 45, views = 100, videoId = '123') => ({ id, url: `https://clips.twitch.tv/${id}`, embed_url: `https://clips.twitch.tv/embed?clip=${id}`, broadcaster_id: '42', broadcaster_name: 'CaseOh', creator_id: '7', creator_name: 'viewer', video_id: videoId, game_id: '1', language: 'en', title: `${id}: Unexpected funny reaction`, view_count: views, created_at: '2026-10-09T00:00:00Z', thumbnail_url: '', duration, vod_offset: offset });
function fixture(clips: ReturnType<typeof clip>[], options: { youtubeDuration?: string; rank?: (c: Candidate[]) => Promise<Highlight[]> } = {}) {
  const queries: URL[] = []; let ranks = 0;
  const twitch = new TwitchClient({ clientId: 'client', secret: '', userToken: 'app' }, async input => {
    const url = new URL(String(input)); queries.push(url);
    return Response.json(url.pathname.endsWith('/videos') ? { data: [vod] } : { data: clips, pagination: {} });
  });
  const youtube = new YouTubeClient('server-key', async () => Response.json({ items: [{ id: 'abcdefghijk', snippet: { title: 'Owned test transcript stream', channelTitle: 'Test', liveBroadcastContent: 'none', thumbnails: {} }, contentDetails: { duration: options.youtubeDuration || 'PT5M' }, statistics: { viewCount: '100' }, status: { embeddable: true, privacyStatus: 'public' } }] }));
  const rank = async (candidates: Candidate[]): Promise<Highlight[]> => { ranks++; return options.rank ? options.rank(candidates) : candidates.map(c => ({ ...c, end: Math.min(c.end, c.start + 30), score: 60 + c.start % 20, title: `Transcript moment ${c.start}`, explanation: 'Setup and payoff are present in the supplied transcript.' })); };
  const root = path.resolve('test-artifacts', `analyzer-${randomUUID()}`);
  return { analyzer: new TimestampAnalyzer(twitch, youtube, root, rank), root, queries, ranks: () => ranks };
}
const transcript = { name: 'owned.json', text: JSON.stringify({ segments: Array.from({ length: 60 }, (_, i) => ({ start: i * 5, end: i * 5 + 5, text: i % 6 === 0 ? 'Wait, no way! We finally won that round!' : 'Here is the setup and the payoff for the next attempt.' })) }), permission: true as const };
test('long transcript analysis bounds model work and returns at most five good moments', async () => {
  const seen: number[] = [];
  const f = fixture([], { youtubeDuration: 'PT2H', rank: async cs => cs.map(c => { seen.push(c.start); return { ...c, end: Math.min(c.end, c.start + 30), score: 90, title: 'Supported moment', explanation: 'A complete reaction.' }; }) });
  const cues = Array.from({ length: 1000 }, (_, i) => ({ start: i * 5, end: i * 5 + 5, text: 'Here is a complete thought.' }));
  const result = await f.analyzer.analyze('https://youtu.be/abcdefghijk', { name: 'long.json', text: JSON.stringify(cues), permission: true });
  assert.equal(seen.length, 24); assert.equal(f.ranks(), 8); assert.equal(result.highlights.length, 5);
  assert.equal(seen[0], 0); assert.equal(seen.at(-1), 4995);
  assert.match(result.warnings.join(' '), /shortlist/i);
  await f.analyzer.analyze('https://youtu.be/abcdefghijk', { name: 'long.json', text: JSON.stringify(cues), permission: true });
  assert.equal(f.ranks(), 8);
});
test('Twitch timestamps use clip start offsets, actual durations and non-overlapping evidence', async () => {
  const f = fixture([clip('First', 3661, 45, 5000), clip('DuplicateMoment', 3665, 30, 4000), clip('Second', 3800, 60), clip('Short', 4000, 12.5), clip('NullOffset', null, 45, 900000), clip('NoVideo', 4200, 45, 900000, ''), clip('Outside', 7190, 45)]);
  const result = await f.analyzer.analyze('https://twitch.tv/caseoh_/schedule?vodID=123');
  assert.equal(result.highlights.length, 3); assert.equal(result.status, 'partial'); assert.equal(result.dataSource, 'existing-clips'); assert.equal(f.ranks(), 0);
  const first = result.highlights.find(h => h.id === 'First')!; assert.equal(first.start, 3661); assert.equal(first.end, 3706); assert.equal(first.startTime, '01:01:01'); assert.equal(first.endTime, '01:01:46');
  assert.equal(result.highlights.find(h => h.id === 'Short')?.duration, 12.5);
  assert.ok(result.highlights.every(h => h.clipUrl && h.confidence === 'metadata-only'));
  assert.ok(f.queries.some(q => q.searchParams.has('started_at') && q.searchParams.has('ended_at')));
  assert.equal(result.scan?.missingOffsets, 1);
});
test('missing offsets, missing video IDs and absent clips give unavailable without invented timestamps', async () => {
  for (const clips of [[], [clip('Null', null)], [clip('NoVideo', 10, 45, 100, '')]]) {
    const result = await fixture(clips).analyzer.analyze('https://www.twitch.tv/videos/123'); assert.equal(result.status, 'unavailable'); assert.deepEqual(result.highlights, []);
  }
});
test('Twitch metadata ranks actual intervals without a duration preference', async () => {
  const result = await fixture([clip('ShortPopular', 0, 20, 999999), ...Array.from({ length: 5 }, (_, i) => clip(`Long${i}`, i * 100, 45))]).analyzer.analyze('123');
  assert.equal(result.highlights.length, 5); assert.ok(result.highlights.some(h => h.id === 'ShortPopular'));
});
test('YouTube supplied transcript yields five qualifying supported highlights and reuses cached rankings', async () => {
  const f = fixture([]); const result = await f.analyzer.analyze('https://youtu.be/abcdefghijk', transcript);
  assert.equal(result.highlights.length, 5); assert.equal(result.dataSource, 'transcript'); assert.equal(result.confidence, 'transcript-supported');
  const ordered = [...result.highlights].sort((a, b) => a.start - b.start);
  assert.ok(ordered.every((h, i) => h.score >= 70 && h.duration === 30 && h.end <= 300 && (!i || h.start >= ordered[i - 1]!.end)));
  const count = f.ranks(); await f.analyzer.analyze('https://youtube.com/live/abcdefghijk', transcript); assert.equal(f.ranks(), count);
});

test('old context-length rankings are ignored so longer complete moments are reconsidered', async () => {
  const cues = Array.from({ length: 20 }, (_, i) => ({ start: i * 15, end: i * 15 + 15, text: 'The complete explanation continues.' }));
  const attachment = { name: 'long.json', text: JSON.stringify(cues), permission: true as const };
  const f = fixture([], { rank: async cs => cs.map(c => ({ ...c, score: 99 - c.start / 10, title: 'Whole explanation', explanation: 'The conclusion needs all of the setup.' })) });
  const legacyKey = createHash('sha256').update(JSON.stringify({ version: 'transcript-natural-ranges-v3', platform: 'youtube', video: 'abcdefghijk', duration: 300, segments: cues, model: config.transcriptOllamaModel })).digest('hex');
  const cached = transcriptCandidates(cues, 300).map(c => ({ ...c, end: c.start + 15, score: 90, title: 'Old fragment', explanation: 'Old context-limited choice.' }));
  await writeJson(path.join(f.root, 'analyzer-cache', `${legacyKey}.json`), cached);
  const result = await f.analyzer.analyze('https://youtu.be/abcdefghijk', attachment);
  assert.ok(f.ranks() > 0); assert.equal(result.highlights[0]?.duration, 300);
});

test('transcript analysis recovers bad batch IDs and retains partial results without accepting invented timing', async () => {
  let fail = true; const requested: string[][] = [];
  const f = fixture([], { rank: async cs => {
    requested.push(cs.map(c => c.id));
    return cs.map(c => ({ ...c, id: fail && c.id === 'transcript-context-0' ? 'invented-id' : c.id, end: Math.min(c.end, c.start + 30), score: 80, title: 'Reaction', explanation: 'Supported reaction.' }));
  } });
  const partial = await f.analyzer.analyze('https://youtu.be/abcdefghijk', transcript);
  assert.ok(partial.highlights.length > 0); assert.equal(partial.status, 'partial');
  assert.ok(partial.highlights.every(h => h.id !== 'invented-id' && h.start >= 5));
  assert.ok(partial.warnings.some(w => /1.*context.*(skip|analyz)/i.test(w)));
  fail = false; requested.length = 0;
  const recovered = await f.analyzer.analyze('https://youtu.be/abcdefghijk', transcript);
  assert.equal(recovered.status, 'ready'); assert.deepEqual(requested, [['transcript-context-0']]);
});
test('YouTube without transcript or known video duration reports unavailable, with no model calls', async () => {
  for (const [options, attachment] of [[{}, undefined], [{ youtubeDuration: 'PT0S' }, transcript]] as const) {
    const f = fixture([], options); const result = await f.analyzer.analyze('https://youtube.com/watch?v=abcdefghijk', attachment);
    assert.equal(result.status, 'unavailable'); assert.equal(result.highlights.length, 0); assert.equal(f.ranks(), 0);
  }
});
test('Ollama cannot invent cue boundaries; short transcript moments are rejected without filler', async () => {
  const malicious = fixture([], { rank: async cs => cs.map(c => ({ ...c, start: c.start + 1, score: 90, title: 'Fake', explanation: 'Fake' })) });
  await assert.rejects(malicious.analyzer.analyze('https://youtu.be/abcdefghijk', transcript), /changed|timing|candidate/i);
  const short = { name: 'short.json', text: JSON.stringify([{ start: 0, end: 10, text: 'Only ten seconds exist.' }]), permission: true as const };
  const f = fixture([], { rank: async cs => cs.map(c => ({ ...c, score: 90, title: 'Short reaction', explanation: 'Complete standalone reaction.' })) });
  const result = await f.analyzer.analyze('https://youtu.be/abcdefghijk', short); assert.equal(result.status, 'unavailable'); assert.deepEqual(result.highlights, []); assert.equal(f.ranks(), 1); await f.analyzer.analyze('https://youtu.be/abcdefghijk', short); assert.equal(f.ranks(), 1);
});

test('Twitch transcript uses Ollama-selected timing and preserves long ranges through cache and seek links', async () => {
  const f = fixture([], { rank: async cs => cs.map(c => ({ ...c, end: c.start < 85 ? 85 : c.end, score: c.start === 0 ? 95 : 10, title: 'Complete story', explanation: 'The payoff needs the full setup.', transcript: 'invented model text' })) });
  const attachment = { name: 'story.json', permission: true as const, text: JSON.stringify([{ start: 0, end: 12, text: 'Setup' }, { start: 12, end: 85, text: 'Payoff' }, { start: 85, end: 100, text: 'Next topic' }]) };
  const result = await f.analyzer.analyze('123', attachment);
  assert.equal(result.dataSource, 'transcript'); assert.equal(result.highlights[0]?.duration, 85);
  assert.equal(result.highlights[0]?.endTime, '00:01:25'); assert.equal(result.highlights[0]?.transcript, 'Setup Payoff');
  assert.match(result.highlights[0]!.originalUrl, /t=0h0m0s/);
  const calls = f.ranks(); const cached = await f.analyzer.analyze('123', attachment);
  assert.equal(f.ranks(), calls); assert.deepEqual(cached.highlights, result.highlights);
  assert.ok(f.queries.every(q => q.pathname.endsWith('/videos')));
});

test('Twitch metadata retains clips longer than sixty seconds', async () => {
  const result = await fixture([clip('LongStory', 100, 95)]).analyzer.analyze('123');
  assert.equal(result.highlights[0]?.duration, 95);
});

test('a highly rated complete long moment is not replaced just to fill five slots', async () => {
  const attachment = { name: 'complete.json', permission: true as const, text: JSON.stringify(Array.from({ length: 12 }, (_, i) => ({ start: i * 15, end: i * 15 + 15, text: 'The story continues to its payoff.' }))) };
  const f = fixture([], { rank: async cs => cs.map(c => ({ ...c, end: c.start === 0 ? 180 : c.start + 15, score: c.start === 0 ? 99 : 10, title: 'Moment', explanation: 'A complete story.' })) });
  const result = await f.analyzer.analyze('https://youtu.be/abcdefghijk', attachment);
  assert.equal(result.highlights.length, 1); assert.equal(result.highlights[0]?.duration, 180); assert.equal(result.highlights[0]?.score, 99);
});
test('date-filtered Twitch scanning paginates, deduplicates and uses bounded fallbacks', async () => {
  const queries: URL[] = [];
  const client = new TwitchClient({ clientId: 'client', secret: '', userToken: 'app' }, async input => {
    const url = new URL(String(input)); queries.push(url);
    if (url.pathname.endsWith('/videos')) return Response.json({ data: [vod] });
    return Response.json({ data: [clip('One', 500)], pagination: url.searchParams.has('after') ? {} : { cursor: 'next' } });
  });
  const scanned = await client.timestampClips('123'); assert.equal(scanned.clips.length, 1); assert.ok(scanned.pages <= 30);
  assert.ok(queries.some(q => q.searchParams.get('after') === 'next')); assert.ok(queries.some(q => q.pathname.endsWith('/clips') && !q.searchParams.has('started_at')));
});
test('a saturated Twitch query without a final cursor still refines dates and reports the search limit', async () => {
  const ranges: string[] = []; let broadPages = 0;
  const client = new TwitchClient({ clientId: 'client', secret: '', userToken: 'app' }, async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/videos')) return Response.json({ data: [vod] });
    const range = `${url.searchParams.get('started_at')}/${url.searchParams.get('ended_at')}`; ranges.push(range);
    if (range !== ranges[0]) return Response.json({ data: [clip('Recovered', 1000)], pagination: {} });
    broadPages++;
    return Response.json({ data: Array.from({ length: 100 }, (_, i) => clip(`Page${broadPages}Clip${i}`, i * 60)), pagination: broadPages < 10 ? { cursor: `page${broadPages + 1}` } : {} });
  });
  const result = await client.timestampClips('123');
  assert.equal(broadPages, 10); assert.equal(result.truncated, true);
  assert.ok(new Set(ranges).size > 1); assert.ok(result.clips.some(c => c.id === 'Recovered')); assert.ok(result.pages <= 30);
});
