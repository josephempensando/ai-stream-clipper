import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, mkdir, writeFile, cp } from 'node:fs/promises';
import { ffmpeg, probe } from '../src/server/media.js';
import { probeAudio } from '../src/server/story/audio.js';
import { StoryStore } from '../src/server/story/store.js';
import { StoryJobManager } from '../src/server/story/jobs.js';
import { runStoryAttempt } from '../src/server/story/pipeline.js';
import { storySettingsSchema, voiceIdSchema } from '../src/shared/story.js';
import { VoicePreviewManager } from '../src/server/story/previews.js';
import { createApp } from '../src/server/app.js';
import type { StoryJob, VoicePreview } from '../src/shared/story.js';
const voiceIndex = process.argv.indexOf('--voice');
const voiceId = voiceIdSchema.parse(voiceIndex < 0 ? 'en_US-lessac-medium' : process.argv[voiceIndex + 1]);
const root = path.resolve('test-artifacts/story-smoke-' + new Date().toISOString().replace(/[:.]/g, '-')); await mkdir(root, { recursive: true });
const sample = path.resolve('assets/story/sample.mp4');
await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x183447:s=640x360:r=30:d=5', '-vf', 'drawgrid=w=80:h=80:t=2:c=0x368477,rotate=0.015*sin(t):fillcolor=0x183447', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', sample]);
const media = await probe(sample); const store = new StoryStore(root); await store.init();
const manager = new StoryJobManager(store, async (...args) => { try { return await runStoryAttempt(...args); } catch (error) { console.error('Live story engine failure:', error); await cp(args[1], path.join(root, 'diagnostic-work'), { recursive: true }); throw error; } });
const previews = new VoicePreviewManager(root); await previews.init();
const services = await createApp(root, undefined, { story: { store, jobs: manager, previews, close: async () => { await Promise.all([manager.close(), previews.close()]); } } });
const server = services.app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve)); const address = server.address(); const base = `http://127.0.0.1:${typeof address === 'object' ? address!.port : 0}/api/story-videos`;
const reports: unknown[] = [];
try {
    const previewResponse = await fetch(base + '/voice-previews', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'A little light can guide the way home.', voiceId, speed: 1 }) });
    assert.equal(previewResponse.status, 202, await previewResponse.clone().text()); const preview = await previewResponse.json() as VoicePreview;
    let current = preview;
    while (!['complete', 'error', 'cancelled'].includes(current.status)) { await new Promise(r => setTimeout(r, 500)); current = await (await fetch(base + '/voice-previews/' + preview.id)).json() as VoicePreview; }
    assert.equal(current.status, 'complete', JSON.stringify(current.error)); assert.equal((await fetch(new URL(current.audioUrl!, base))).status, 200); const measured = await probeAudio(await previews.audioPath(preview.id)); assert.ok(measured.duration > 0);
    console.log('Real local voice preview:', measured.duration, 'seconds');
    await fetch(base + '/voice-previews/' + preview.id, { method: 'DELETE' });
  for (const name of (process.argv.includes('--short-only') ? ['short'] : process.argv.includes('--long-only') ? ['long'] : ['short', 'long'])) {
    const script = (await readFile(`assets/story/${name}.txt`, 'utf8')).trim();
    const settings = storySettingsSchema.parse({ script, voiceId, speed: name === 'long' ? 0.85 : 1, rights: { footagePermission: true }, layout: 'crop', subtitles: { animation: 'karaoke' } });
    const form = new FormData(); form.append('settings', JSON.stringify(settings)); form.append('background', new Blob([await readFile(sample)], { type: 'video/mp4' }), 'sample.mp4');
    const response = await fetch(base, { method: 'POST', body: form }); assert.equal(response.status, 202, await response.clone().text()); const job = await response.json() as StoryJob;
    let done = job; let last = '';
    while (!['complete', 'cancelled', 'error'].includes(done.status)) { const message = `${name} ${done.status} ${done.progress.stage} ${Math.floor(done.progress.percent)}%`; if (message !== last) { console.log(message); last = message; } await new Promise(r => setTimeout(r, 1500)); done = await (await fetch(base + '/' + job.id)).json() as StoryJob; }
    assert.equal(done.status, 'complete', JSON.stringify(done.error));
    const output = await store.artifactPath(job.id, 'video.mp4'); const info = await probe(output); const audio = await probeAudio(output);
    const record = store.get(job.id); const manifest = JSON.parse(await readFile(await store.artifactPath(job.id, 'results.json'), 'utf8'));
    assert.equal(manifest.script, script); assert.equal(manifest.captionCoverage, 1); assert.ok(Math.abs(info.duration - done.actualDuration!) <= 0.1); assert.equal(info.width, 1080); assert.equal(info.height, 1920);
    assert.equal(manifest.segments.flatMap((s: { words: { word: string }[] }) => s.words.map(w => w.word)).join(' ').replace(/\s+/g, ' ').trim(), script.replace(/\s+/g, ' ').trim());
    const range = await fetch(base + '/' + job.id + '/preview', { headers: { Range: 'bytes=0-31' } }); assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 32);
    const download = await fetch(base + '/' + job.id + '/download'); assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition') || '', /attachment/); assert.equal((await download.arrayBuffer()).byteLength, (await readFile(output)).length);
    assert.ok(name === 'short' ? done.actualDuration! < 30 : done.actualDuration! > 60);
    assert.ok(done.actualDuration! > media.duration); assert.ok((await readFile(await store.artifactPath(job.id, 'captions.srt'), 'utf8')).includes(name === 'short' ? 'over.' : 'home.'));
    reports.push({ name, jobId: job.id, output, engines: manifest.engines, settings, narrationDuration: record.actualDuration, videoDuration: info.duration, audio, captionCoverage: manifest.captionCoverage, warnings: done.warnings, httpPreview: 206, httpDownload: 200 });
    console.log('Live story complete:', reports.at(-1));
  }
  await writeFile(path.join(root, 'validation.json'), JSON.stringify(reports, null, 2)); console.log('Live evidence:', root);
} finally { await services.story.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
