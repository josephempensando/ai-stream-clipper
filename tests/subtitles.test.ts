import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSrt } from '../src/server/subtitles.js';
import { renderClips } from '../src/server/render.js';
import { ffmpeg } from '../src/server/media.js';
import { config } from '../src/server/config.js';
import { runProcess } from '../src/server/process.js';
import type { Job } from '../src/shared/types.js';

const paragraph = 'What does any of this mean? Big dog. I came on stream today. There was like 20 people talking about doggy verified grief.';

test('long transcript passages become short captions with at most two lines', () => {
  const srt = createSrt([{ start: 0, end: 24, text: paragraph }], 0, 24);
  const cues = srt.trim().split('\n\n').map(block => block.split('\n'));
  assert.ok(cues.length >= 2);
  for (const cue of cues) {
    const lines = cue.slice(2);
    assert.ok(lines.length <= 2);
    assert.ok(lines.every(line => line.length <= 32));
  }
  assert.equal(cues.flatMap(cue => cue.slice(2)).join(' '), paragraph);
  assert.match(srt, /00:00:00,000 -->/);
  assert.match(srt, /--> 00:00:24,000/);
});

test('cutting a long passage keeps the original caption timing', () => {
  const segment = { start: 10, end: 34, text: paragraph };
  const full = createSrt([segment], 10, 34);
  const cut = createSrt([segment], 30, 34);
  assert.ok(!cut.includes('What does'));
  assert.ok(full.includes('verified grief.'));
  assert.ok(cut.includes('verified grief.'));
  assert.match(cut, /--> 00:00:04,000/);
});

test('actual vertical export draws small captions at bottom center', { timeout: 180_000 }, async () => {
  const root = path.resolve('test-artifacts', `subtitles-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const source = path.join(root, 'black.mp4');
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=5:d=30', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', source]);
  const highlight = { id: 'caption', start: 0, end: 30, title: 'Caption test', explanation: 'Generated fixture', score: 90, heuristicScore: 0, evidence: [], transcript: paragraph, frameTimes: [] };
  const job: Job = { id: 'caption-test', name: 'Generated black recording', createdAt: new Date().toISOString(), status: 'review', stage: '', progress: 100, media: { duration: 30, width: 160, height: 90, hasAudio: true }, mediaHash: 'test', source: 'upload', vodId: null, vodOffset: 0, highlights: [highlight], outputs: [], warnings: [], error: null, renderOptions: null };
  await renderClips(job, source, root, [{ id: highlight.id, start: 0, end: 30 }], { layout: 'crop', cropX: 0.5, subtitles: true }, { segments: [{ start: 0, end: 24, text: paragraph }], language: 'en', model: 'test-double' }, async () => {});
  const lines: string[] = [];
  await runProcess(config.ffmpeg, ['-hide_banner', '-ss', '0.5', '-i', path.join(root, 'clip-01.mp4'), '-vf', 'bbox=min_val=180', '-frames:v', '1', '-an', '-f', 'null', '-'], { onLine: line => lines.push(line) });
  const bounds = lines.join('\n').match(/x1:(\d+) x2:(\d+) y1:(\d+) y2:(\d+) w:(\d+) h:(\d+)/);
  assert.ok(bounds, lines.join('\n'));
  const [, x1, x2, y1, y2, width, height] = bounds.map(Number);
  assert.ok(y1! >= 1640, `Caption starts too high: ${bounds[0]}`);
  assert.ok(y2! <= 1840 && y2! >= 1760, `Wrong bottom margin: ${bounds[0]}`);
  assert.ok(width! <= 920 && height! <= 120, `Caption is too large: ${bounds[0]}`);
  assert.ok(Math.abs((x1! + x2!) / 2 - 540) <= 20, `Caption is not centered: ${bounds[0]}`);
  await ffmpeg(['-ss', '0.5', '-i', path.join(root, 'clip-01.mp4'), '-frames:v', '1', path.join(root, 'preview.png')]);
  console.log(`Subtitle position verified in actual rendered frame: ${root}`);
});
