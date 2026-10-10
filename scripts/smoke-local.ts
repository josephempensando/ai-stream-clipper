import path from 'node:path';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { health } from '../src/server/health.js';
import { JobStore, hashFile } from '../src/server/store.js';
import { JobManager } from '../src/server/jobs.js';
import { probe } from '../src/server/media.js';
import type { Job } from '../src/shared/types.js';
import { sourceRightsSchema, unknownRights } from '../src/shared/rights.js';
import { config } from '../src/server/config.js';
import { analysisSettingsSchema } from '../src/shared/validation.js';

const file = process.argv[2];
if (!file || !process.argv.includes('--authorized')) throw new Error('Usage: npm run smoke:local -- C:\\path\\owned-recording.mp4 --authorized [--clip-count 5] [--rights path/to/rights.json]');
const countIndex = process.argv.indexOf('--clip-count');
if (countIndex !== -1 && !process.argv[countIndex + 1]) throw new Error('--clip-count requires a number.');
const settings = analysisSettingsSchema.parse({ durationMode: 'auto', clipCount: countIndex === -1 ? config.clipCount ?? 5 : process.argv[countIndex + 1] });
const rightsIndex = process.argv.indexOf('--rights');
if (rightsIndex !== -1 && !process.argv[rightsIndex + 1]) throw new Error('--rights requires a JSON file path.');
const rights = rightsIndex === -1 ? unknownRights() : sourceRightsSchema.parse(JSON.parse(await readFile(process.argv[rightsIndex + 1]!, 'utf8')));
const state = await health(); console.log('Local engine readiness:', state);
if (!state.ffmpeg || !state.ffprobe || !state.whisper || !state.ollama) throw new Error('Install/configure missing local engines before running the live smoke test.');
const store = new JobStore(path.resolve('data/live-smoke')); await store.init(); const id = randomUUID();
await mkdir(store.dir(id), { recursive: true }); await copyFile(file, store.mediaPath(id));
const job: Job = { id, name: path.basename(file), createdAt: new Date().toISOString(), status: 'uploaded', stage: 'Ready', progress: 0, media: await probe(file), mediaHash: await hashFile(file), source: 'upload', vodId: null, vodOffset: 0, highlights: [], outputs: [], warnings: [], error: null, renderOptions: null, rights, durationMode: settings.durationMode, clipCount: settings.clipCount ?? 5 };
await store.save(job); const manager = new JobManager(store);
const progress = setInterval(() => console.log(`${job.stage}: ${Math.round(job.progress)}%`), 15_000); progress.unref();
try {
await manager.analyze(id); await manager.idle();
if (job.status !== 'review') throw new Error(job.error || 'Analysis failed.');
console.log('Live Whisper/Ollama highlights:', job.highlights);
if (!job.highlights.length) throw new Error('Analysis completed without qualifying highlights; no draft was fabricated.');
await manager.render(id, job.highlights.map(({ id, start, end }) => ({ id, start, end })), { layout: 'blur', cropX: 0.5, subtitles: false }); await manager.idle();
if (store.get(id).status !== 'complete') throw new Error(job.error || 'Rendering failed.');
console.log(`Live end-to-end test passed. Outputs: ${store.dir(id)}\\exports`);
} finally { clearInterval(progress); }
