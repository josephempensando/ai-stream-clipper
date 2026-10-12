import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, readdir, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createDemo } from '../scripts/create-demo.js';
import { probe, detectEvidence, ffmpeg } from '../src/server/media.js';
import { config } from '../src/server/config.js';
import { renderClips } from '../src/server/render.js';
import { runProcess } from '../src/server/process.js';
import type { Transcript } from '../src/shared/types.js';
import { JobStore, readJson, writeJson } from '../src/server/store.js';
import { JobManager } from '../src/server/jobs.js';
import { createApp } from '../src/server/app.js';
import type { Highlight, Job } from '../src/shared/types.js';
import type { PipelineAdapters } from '../src/server/pipeline.js';

test('owned generated recording: HTTP upload → analysis with explicit model doubles → five actual vertical MP4s + ZIP', { timeout: 600_000 }, async t => {
  const root = path.resolve('test-artifacts', `media-${randomUUID()}`); await mkdir(root, { recursive: true });
  const chunkSeconds = config.chunkSeconds; config.chunkSeconds = 120; t.after(() => { config.chunkSeconds = chunkSeconds; });
  const recording = path.join(root, 'owned-synthetic.mp4'); await createDemo(recording, 300);
  const info = await probe(recording); assert.ok(info.hasAudio); assert.ok(Math.abs(info.duration - 300) < 1);
  let transcriptionCalls = 0; let rankCalls = 0; let singleMoments = false;
  // These are explicitly test-only doubles, not a claim that Whisper/Ollama ran.
  const adapters: PipelineAdapters = {
    transcribe: async () => { transcriptionCalls++; return Array.from({ length: 24 }, (_, i) => ({ start: i * 5, end: i * 5 + 5, text: i % 4 === 0 ? 'Wait! No way! What a surprising clutch!' : 'We are setting up the next round.' })); },
    rank: async candidates => { rankCalls++; return candidates.map(c => {
      const start = c.cues![0]!.start;
      return { ...c, start, end: singleMoments ? c.cues![0]!.end : Math.min(c.cues!.at(-1)!.end, start + (start === 100 ? 145 : 15)), score: start === 0 ? 99 : start === 100 ? 95 : 70, title: `TEST DOUBLE: moment ${start}`, explanation: 'Fixture ranking for generated owned media; no real model inference.' };
    }); },
  };
  const store = new JobStore(root); const manager = new JobManager(store, adapters); const { app } = await createApp(root, manager);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`;
  const makeForm = (permission: string) => { const f = new FormData(); f.append('permission', permission); f.append('clipCount', '5'); f.append('vodOffset', '600'); f.append('media', new Blob([fileBytes], { type: 'video/mp4' }), 'owned.mp4'); return f; };
  const fileBytes = await readFile(recording);
  const denied = await fetch(`${base}/api/jobs/upload`, { method: 'POST', body: makeForm('false') }); assert.equal(denied.status, 400);
  const uploaded = await fetch(`${base}/api/jobs/upload`, { method: 'POST', body: makeForm('true') }); assert.equal(uploaded.status, 201);
  const job = await uploaded.json() as Job;
  assert.equal(job.vodOffset, 600); assert.equal(job.source, 'upload');
  assert.equal((await fetch(`${base}/api/jobs/${job.id}/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"clipCount":5}' })).status, 202);
  await manager.idle(); const analyzed = store.get(job.id); assert.equal(analyzed.status, 'review', analyzed.error || '');
  assert.equal(analyzed.highlights.length, 5); assert.equal(transcriptionCalls, 3); assert.ok(rankCalls > 0);
  assert.ok(analyzed.highlights.some(h => h.end - h.start === 15));
  assert.ok(analyzed.highlights.some(h => h.end - h.start === 145));
  assert.ok(analyzed.highlights.every(h => h.duration === h.end - h.start && h.startTime === h.start && h.endTime === h.end && h.reasonForSelection === h.explanation && h.engagementScore === h.score));
  const transcript = await readJson<{ segments: { start: number; end: number }[] }>(path.join(store.dir(job.id), 'transcript.json'));
  assert.ok(transcript?.segments.some(s => s.start === 240)); assert.ok(transcript?.segments.every(s => s.end <= 300));
  const calls = rankCalls; await manager.analyze(job.id); await manager.idle(); assert.equal(transcriptionCalls, 3); assert.equal(rankCalls, calls);
  const countChanged = await fetch(`${base}/api/jobs/${job.id}/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ durationMode: 'auto', clipCount: 7 }) });
  assert.equal(countChanged.status, 202); await manager.idle();
  assert.equal(store.get(job.id).clipCount, 7); assert.equal(store.get(job.id).highlights.length, 7); assert.equal(rankCalls, calls);
  await manager.analyze(job.id, { clipCount: 5 }); await manager.idle();
  // An older ranking cache cannot restore fixed windows; speech is reused.
  const [cacheName] = await readdir(path.join(root, 'cache')); assert.ok(cacheName);
  const cache = path.join(root, 'cache', cacheName);
  const ranges = path.join(cache, `shortlist-v1-budget-${config.highlightContextBudget}-silence-${config.maxHighlightSilenceSeconds}`);
  await rename(ranges, path.join(cache, 'saved-natural-ranges'));
  await writeJson(path.join(cache, 'ranking-0.json'), [{ id: 'legacy-fixed-window', start: 0, end: 45 }]);
  await manager.analyze(job.id); await manager.idle();
  assert.equal(store.get(job.id).status, 'review'); assert.equal(transcriptionCalls, 3); assert.ok(rankCalls > calls);
  // Invalid cached model ranges are discarded and recomputed without redoing speech.
  const rankingFile = path.join(ranges, 'ranking-0.json');
  const saved = await readJson<{ rankings: Highlight[]; reviewed: string[] }>(rankingFile); assert.ok(saved?.rankings.length);
  await writeJson(rankingFile, { ...saved, rankings: saved.rankings.map((h, i) => i === 0 ? { ...h, end: 301 } : h) });
  await manager.analyze(job.id); await manager.idle();
  assert.equal(store.get(job.id).status, 'review'); assert.ok(store.get(job.id).warnings.some(w => /invalid cached ranking/i.test(w)));
  await writeJson(rankingFile, saved);
  await manager.analyze(job.id); await manager.idle(); assert.equal(store.get(job.id).status, 'review'); assert.equal(transcriptionCalls, 3);
  const edits = analyzed.highlights.map(h => ({ id: h.id, start: h.start, end: h.end }));
  const rendered = await fetch(`${base}/api/jobs/${job.id}/render`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clips: edits, options: { layout: 'blur', cropX: 0.5, subtitles: false } }) });
  assert.equal(rendered.status, 202); await manager.idle(); const completed = store.get(job.id); assert.equal(completed.status, 'complete', completed.error || '');
  assert.equal(completed.outputs.length, 5);
  for (const [index, output] of completed.outputs.entries()) {
    assert.equal(output.file, `clip-0${index + 1}.mp4`);
    const actual = await probe(path.join(store.dir(job.id), 'exports', output.file));
    assert.equal(actual.width, 1080); assert.equal(actual.height, 1920); assert.equal(actual.hasAudio, true); assert.ok(Math.abs(actual.duration - (edits[index]!.end - edits[index]!.start)) < 0.15);
    const timing = JSON.parse(await runProcess(config.ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,start_time,duration', '-of', 'json', path.join(store.dir(job.id), 'exports', output.file)])) as { streams: { start_time: string; duration: string }[] };
    assert.ok(timing.streams.every(s => Math.abs(Number(s.start_time)) < 0.08));
    assert.ok(Math.abs(Number(timing.streams[0]?.duration) - Number(timing.streams[1]?.duration)) < 0.15);
  }
  const manifest = await (await fetch(`${base}/api/jobs/${job.id}/results`)).json() as { outputs: unknown[]; highlights: { vodStart: number }[]; models: { whisper: string; ollama: string } };
  assert.equal(manifest.models.whisper, 'test-double'); assert.equal(manifest.models.ollama, 'test-double');
  assert.equal(manifest.outputs.length, 5); assert.equal(manifest.highlights[0]?.vodStart, edits[0]!.start + 600);
  const zip = await fetch(`${base}/api/jobs/${job.id}/zip`); assert.equal(zip.status, 200);
  const zipBytes = Buffer.from(await zip.arrayBuffer()); assert.equal(zipBytes.readUInt32LE(0), 0x04034b50);
  for (const file of ['clip-01.mp4', 'clip-05.mp4', 'results.json']) assert.ok(zipBytes.includes(Buffer.from(file)));
  assert.equal((await fetch(`${base}/api/jobs/${job.id}/files/source.mp4`)).status, 404);
  assert.equal((await fetch(`${base}/api/jobs/${job.id}/files/clip-01.mp4`)).status, 200);
  // Crop and burn-in subtitles also preserve the model-selected duration.
  const cropDir = path.join(root, 'crop-subtitle-test');
  const fullTranscript = await readJson<Transcript>(path.join(store.dir(job.id), 'transcript.json')); assert.ok(fullTranscript);
  await renderClips(completed, store.mediaPath(job.id), cropDir, [edits[0]!], { layout: 'crop', cropX: 0.25, subtitles: true }, fullTranscript, async () => {});
  assert.match(await readFile(path.join(cropDir, 'clip-01.srt'), 'utf8'), /00:00:/);
  const cropped = await probe(path.join(cropDir, 'clip-01.mp4')); assert.equal(cropped.width, 1080); assert.equal(cropped.height, 1920);
  // Legacy All requests now use the eight-clip cap and a bounded shortlist.
  await rename(ranges, path.join(cache, 'saved-multi-sentence-ranges')); singleMoments = true;
  const allResponse = await fetch(`${base}/api/jobs/${job.id}/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clipCount: 'all', minEngagementScore: 70 }) });
  assert.equal(allResponse.status, 202); await manager.idle();
  assert.equal(store.get(job.id).status, 'review', store.get(job.id).error || '');
  assert.equal(store.get(job.id).highlights.length, 8); assert.equal(transcriptionCalls, 3);
  const allCalls = rankCalls;
  await manager.analyze(job.id, { clipCount: 'all', minEngagementScore: 90 }); await manager.idle();
  assert.equal(store.get(job.id).highlights.length, 2); assert.equal(rankCalls, allCalls); assert.equal(transcriptionCalls, 3);
  console.log(`Actual media validation artifacts: ${root}. Whisper and Ollama used test-only doubles.`);
});
test('48 kHz recording preserves short energy spikes in per-second evidence', { timeout: 30_000 }, async () => {
  const root = path.resolve('test-artifacts', `energy-${randomUUID()}`); await mkdir(root, { recursive: true });
  const recording = path.join(root, 'spikes.mp4');
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=5:d=3', '-f', 'lavfi', '-i', 'aevalsrc=if(lt(mod(t\\,1)\\,0.2)\\,0.8\\,0.001):s=48000:d=3', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', recording]);
  const evidence = await detectEvidence(recording);
  assert.ok(evidence.filter(e => e.time < 3).every(e => e.loudness > -20), JSON.stringify(evidence));
});
