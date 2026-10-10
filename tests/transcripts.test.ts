import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript, transcriptCandidates, transcriptSupports } from '../src/server/transcripts.js';
test('SRT and VTT parse absolute timestamps, multiline captions and VTT settings', () => {
  const srt = parseTranscript('sample.srt', '1\n01:02:03,250 --> 01:02:10,000\nHello <b>world</b>\nAgain\n\n2\n01:02:10,000 --> 01:02:35,250\nNo way!', 4000);
  assert.equal(srt.segments[0]?.start, 3723.25); assert.equal(srt.segments[0]?.text, 'Hello world Again');
  const vtt = parseTranscript('sample.vtt', 'WEBVTT\n\nNOTE authorized transcript\nmetadata\n\ncue-1\n00:00.000 --> 00:40.000 align:start position:0%\n&amp; Great!', 60);
  assert.equal(vtt.segments.length, 1); assert.equal(vtt.segments[0]?.text, '& Great!');
});
test('timestamped JSON/TXT are supported and invalid/out-of-video timings fail', () => {
  assert.equal(parseTranscript('sample.json', JSON.stringify({ segments: [{ start: 5, end: 40, text: 'A moment' }] }), 60).segments[0]?.end, 40);
  assert.equal(parseTranscript('sample.txt', '[00:00:05] --> [00:00:40] A moment', 60).segments[0]?.start, 5);
  const points = parseTranscript('sample.txt', '[00:00:05] setup\n[00:00:20] payoff\n[00:00:40]', 60); assert.equal(points.segments[1]?.end, 40);
  for (const content of ['1\n00:61:00,000 --> 00:62:00,000\nBad', '1\n00:00:20,000 --> 00:00:10,000\nBad', '1\n00:00:00,000 --> 00:01:01,000\nOutside']) assert.throws(() => parseTranscript('bad.srt', content, 60));
  assert.throws(() => parseTranscript('bad.txt', 'An untimed paragraph', 60));
});
test('transcript candidates stay within supported cue windows, never fill long gaps and can supply five', () => {
  const segments = Array.from({ length: 60 }, (_, i) => ({ start: i * 5, end: i * 5 + 5, text: i % 6 === 0 ? 'Wait, no way! A funny surprise!' : 'This is the setup and the payoff for our round.' }));
  const windows = transcriptCandidates(segments, 300);
  assert.ok(windows.length >= 5); assert.ok(windows.length <= 120);
  assert.ok(windows.every(c => transcriptSupports(segments, c.start, c.end, 300)));
  assert.ok(windows.some(c => c.end - c.start > 60));
  assert.equal(transcriptSupports([{ start: 0, end: 10, text: 'one' }, { start: 40, end: 60, text: 'two' }], 0, 60, 60), false);
  assert.equal(transcriptCandidates([{ start: 0, end: 10, text: 'short' }], 300).length, 1);
});

test('transcript support allows short and long moments but requires real cue boundaries', () => {
  const cues = [{ start: 0, end: 12.5, text: 'Reaction' }, { start: 12.5, end: 85, text: 'Resolution' }];
  assert.equal(transcriptSupports(cues, 0, 12.5, 100), true);
  assert.equal(transcriptSupports(cues, 0, 85, 100), true);
  for (const [start, end] of [[1, 12.5], [0, 84], [0, 101], [0, 0]]) assert.equal(transcriptSupports(cues, start!, end!, 100), false);
});
