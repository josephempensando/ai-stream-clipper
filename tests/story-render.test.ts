import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ffmpeg, probe } from '../src/server/media.js';
import { prepareStoryBackground } from '../src/server/story/background.js';
import { prepareMusicLoop } from '../src/server/story/background.js';
import { renderStory } from '../src/server/story/render.js';
import { writeStoryCaptions } from '../src/server/story/captions.js';
import { storySettingsSchema } from '../src/shared/story.js';
import { config } from '../src/server/config.js';
import { runProcess } from '../src/server/process.js';
test('real FFmpeg renders a 3-second story over looping footage, final caption and AAC audio intact', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'story-render-')); const workDir = path.join(root, 'work'); await mkdir(workDir);
  try {
    const video = path.join(root, 'background.mp4'); const narration = path.join(root, 'narration.wav');
    await ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30:d=1', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
    await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3:sample_rate=48000', '-ac', '1', narration]);
    const settings = storySettingsSchema.parse({ script: 'The final word.', voiceId: 'test', rights: { footagePermission: true } });
    const captions = await writeStoryCaptions([{ start: 0.1, end: 2.95, text: 'The final word.', words: [{ start: 0.1, end: 0.5, word: 'The' }, { start: 0.6, end: 1.2, word: 'final' }, { start: 2.4, end: 2.95, word: 'word.' }] }], 3, settings.subtitles, root);
    const signal = new AbortController().signal; const background = await prepareStoryBackground({ video, duration: 3, settings, workDir }, signal);
    const result = await renderStory({ background, narrationFile: narration, narrationDuration: 3, assFile: captions.assFile, outputDirectory: root, settings }, signal, async () => {});
    assert.ok(Math.abs(result.videoDuration - 3) <= 0.1); assert.equal((await probe(result.videoFile)).width, 1080);
    const streams = JSON.parse(await runProcess(config.ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', result.videoFile])).streams;
    assert.equal(streams[0].codec_name, 'h264'); assert.equal(streams[1].codec_name, 'aac'); assert.ok(Number(streams[1].duration) >= 2.95);
    assert.match(await readFile(captions.srtFile, 'utf8'), /word\./);
    let finalAudio = ''; await runProcess(config.ffmpeg, ['-hide_banner', '-i', result.videoFile, '-ss', '2.7', '-t', '0.2', '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { onLine: line => { finalAudio += line + '\n'; } });
    const peak = /max_volume: (-?[\d.]+) dB/.exec(finalAudio); assert.ok(peak && Number(peak[1]) > -35, 'final audio marker must remain audible');
    await assert.rejects(renderStory({ background, narrationFile: narration, narrationDuration: 3, outputDirectory: root, settings }, signal, async () => { throw new Error('progress persistence failure'); }), /progress persistence failure/);
    const interrupted = new AbortController(); await assert.rejects(renderStory({ background, narrationFile: narration, narrationDuration: 3, outputDirectory: root, settings }, interrupted.signal, async () => { interrupted.abort(); }), /abort/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('music repeats through a smooth PCM seam and enabled original audio mixes safely', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'story-mix-')); const workDir = path.join(root, 'work'); await mkdir(workDir);
  try {
    const music = path.join(root, 'music.wav'); const video = path.join(root, 'background.mp4'); const signal = new AbortController().signal;
    await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=337.33:duration=0.8:sample_rate=48000', '-c:a', 'pcm_s16le', music]);
    const loop = await prepareMusicLoop(music, workDir, 3, signal); const raw = path.join(root, 'samples.raw'); await ffmpeg(['-i', loop, '-f', 'f32le', '-ac', '1', '-ar', '48000', raw]); const data = await readFile(raw);
    assert.ok(Math.abs(data.readFloatLE(0) - data.readFloatLE(data.length - 4)) < 0.025, `repeat endpoints must meet without an abrupt audio jump: ${data.readFloatLE(0)} / ${data.readFloatLE(data.length - 4)}, samples=${data.length / 4}`);
    await ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30:d=1', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=1', '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', video]);
    const settings = storySettingsSchema.parse({ script: 'A story.', voiceId: 'test', backgroundMuted: false, rights: { footagePermission: true, music: { permission: true, license: 'owned', provenance: 'Generated tone' } } });
    const prepared = await prepareStoryBackground({ video, music, duration: 3, settings, workDir }, signal); assert.ok(prepared.bedFile);
    const rendered = await renderStory({ background: prepared, narrationFile: music, narrationDuration: 0.8, outputDirectory: root, settings }, signal, async () => {}); assert.ok(Math.abs(rendered.videoDuration - 0.8) <= 0.1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
