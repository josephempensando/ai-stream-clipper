import path from 'node:path';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { config } from '../src/server/config.js';
import { runProcess } from '../src/server/process.js';
import { ffmpeg, probe } from '../src/server/media.js';
import { hashFile, JobStore } from '../src/server/store.js';
import { JobManager } from '../src/server/jobs.js';
import { retentionSettingsSchema } from '../src/shared/retention.js';
import { unknownRights } from '../src/shared/rights.js';
import type { Job } from '../src/shared/types.js';

const generated = process.argv.includes('--generated-owned-sample');
const input = process.argv[2];
if (!generated && (!input || !process.argv.includes('--authorized'))) throw new Error('Usage: npx tsx scripts/smoke-retention.ts <owned.mp4> --authorized OR --generated-owned-sample (Windows System.Speech).');
const root = path.resolve('test-artifacts', `live-retention-${randomUUID()}`); await mkdir(root, { recursive: true });
let file = input!;
if (generated) {
  const wav = path.join(root, 'owned-narration.wav'); const script = path.join(root, 'narrate.ps1');
  // Original synthetic narration, generated locally; no third-party footage or music.
  await writeFile(script, `Add-Type -AssemblyName System.Speech\n$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer\n$speaker.Rate = 0\n$speaker.SetOutputToWaveFile('${wav.replaceAll("'", "''")}')\n$speaker.Speak('Why did my computer keep shutting down? I checked the software and found no errors. Then I opened the case and saw a thick layer of dust blocking the fan. After I cleaned the fan, the temperature dropped and the shutdowns stopped. The problem was airflow, and cleaning the fan solved it.')\n$speaker.Dispose()\n`);
  await runProcess('powershell', ['-NoProfile', '-File', script], { timeout: 30000 });
  const timing = JSON.parse(await runProcess(config.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', wav])) as { format: { duration: string } };
  file = path.join(root, 'owned-source.mp4');
  await ffmpeg(['-f', 'lavfi', '-i', `testsrc2=s=640x360:r=30:d=${timing.format.duration}`, '-i', wav, '-t', timing.format.duration, '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', file]);
}
const store = new JobStore(root); await store.init(); const id = randomUUID(); await mkdir(store.dir(id), { recursive: true }); await copyFile(file, store.mediaPath(id));
const settings = retentionSettingsSchema.parse({ autoEdit: true });
const job: Job = { id, name: path.basename(file), createdAt: new Date().toISOString(), status: 'uploaded', stage: 'Ready', progress: 0, media: await probe(file), mediaHash: await hashFile(file), source: 'upload', vodId: null, vodOffset: 0, highlights: [], outputs: [], warnings: [], error: null, renderOptions: null, rights: unknownRights(), durationMode: 'auto', clipCount: 1, minEngagementScore: 0, retentionSettings: settings };
await store.save(job); const manager = new JobManager(store);
const timer = setInterval(() => console.log(`${job.stage}: ${Math.round(job.progress)}%`), 10000); timer.unref();
try {
  await manager.analyze(id, { clipCount: 1, minEngagementScore: 0, retention: settings }); await manager.idle();
  assert.equal(job.status, 'review', job.error || 'Analysis failed.'); assert.ok(job.highlights.length, 'No highlight qualified; no substitute was invented.');
  assert.ok(job.highlights.every(h => h.retention));
  await manager.render(id, job.highlights.map(h => ({ id: h.id, start: h.start, end: h.end })), { layout: 'blur', cropX: 0.5, subtitles: true, retention: settings }); await manager.idle();
  assert.equal(store.get(id).status, 'complete', job.error || 'Render failed.');
  for (const output of job.outputs) {
    const exported = path.join(store.dir(id), 'exports', output.file); const media = await probe(exported); assert.equal(media.width, 1080); assert.equal(media.height, 1920);
    const streams = JSON.parse(await runProcess(config.ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,start_time,duration', '-of', 'json', exported])).streams as { start_time: string; duration: string }[];
    assert.ok(streams.every(s => Math.abs(Number(s.start_time)) < 0.08)); assert.ok(Math.abs(Number(streams[0]?.duration) - Number(streams[1]?.duration)) < 0.15);
    await ffmpeg(['-v', 'error', '-i', exported, '-f', 'null', '-']);
  }
  await writeFile(path.join(root, 'validation.json'), JSON.stringify({ generatedOwnedSample: generated, actualWhisper: config.whisperModel, actualOllama: config.ollamaModel, jobId: id, highlights: job.highlights, warnings: job.warnings, outputs: job.outputs }, null, 2));
  console.log(`Actual Whisper → Ollama → narrative/EDL → FFmpeg validation passed: ${root}`);
} finally { clearInterval(timer); }
