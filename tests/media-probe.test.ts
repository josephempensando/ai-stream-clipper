import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ffmpeg, probe } from '../src/server/media.js';

test('MP4 probing accepts an actual video track', async () => {
  const root = path.resolve('test-artifacts', `probe-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const file = path.join(root, 'video.mp4');
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=5:d=1', '-c:v', 'libx264', '-preset', 'ultrafast', file]);
  const media = await probe(file);
  assert.equal(media.width, 160); assert.equal(media.height, 90); assert.equal(media.hasAudio, false);
});

test('a renamed non-MP4 video reports its detected container and conversion advice', async () => {
  const root = path.resolve('test-artifacts', `probe-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const file = path.join(root, 'renamed.mp4');
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=5:d=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-f', 'matroska', file]);
  await assert.rejects(probe(file), /matroska.*convert.*MP4/i);
});

test('an audio-only MP4 reports the missing video track', async () => {
  const root = path.resolve('test-artifacts', `probe-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const file = path.join(root, 'audio-only.mp4');
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac', file]);
  await assert.rejects(probe(file), /only audio.*no video track/i);
});
