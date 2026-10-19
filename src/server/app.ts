import express from 'express';
import type { ErrorRequestHandler } from 'express';
import multer from 'multer';
import { ZipArchive } from 'archiver';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { config } from './config.js';
import { JobStore, hashFile, readJson } from './store.js';
import { JobManager } from './jobs.js';
import { TwitchClient } from './twitch.js';
import { TwitchOAuth } from './twitch-oauth.js';
import { TwitchLiveStore } from './twitch-live.js';
import { TwitchApiError } from './twitch-http.js';
import { clipIdSchema } from './twitch-public.js';
import { YouTubeApiError } from './youtube.js';
import { TimestampAnalyzer } from './timestamp-analyzer.js';
import { TRANSCRIPT_MAX_BYTES } from './transcripts.js';
import { health } from './health.js';
import { prepareRecording } from './media.js';
import { downloadApproved } from './security.js';
import { parseVodId, renderSchema, analysisSettingsSchema } from '../shared/validation.js';
import type { Job, Transcript } from '../shared/types.js';
import { retentionSettingsSchema } from '../shared/retention.js';
import { runProcess } from './process.js';
import { assessRights, normalizeRights, sourceRightsSchema, platforms, rightsUses } from '../shared/rights.js';

const requestAnalysisSettings = analysisSettingsSchema.extend({ clipCount: analysisSettingsSchema.shape.clipCount.removeDefault().optional() });
const uploadMeta = z.object({ permission: z.literal('true'), vodId: z.string().default(''), vodOffset: z.coerce.number().finite().nonnegative().default(0), rights: z.string().max(20000).optional(), ...requestAnalysisSettings.shape });
export async function createApp(root = config.dataDir, managerOverride?: JobManager, integrations: { twitch?: TwitchClient; oauth?: TwitchOAuth; analyzer?: TimestampAnalyzer } = {}) {
  const store = managerOverride?.store || new JobStore(root); await store.init();
  const manager = managerOverride || new JobManager(store); const twitch = integrations.twitch || new TwitchClient();
  const oauth = integrations.oauth || new TwitchOAuth(); const twitchLive = new TwitchLiveStore(root, twitch); await twitchLive.init();
  const analyzer = integrations.analyzer || new TimestampAnalyzer(twitch, undefined, root);
  const app = express(); app.disable('x-powered-by');
  app.use((req, res, next) => {
    const host = req.hostname;
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) { res.status(403).json({ error: 'Local host only.' }); return; }
    const origin = req.headers.origin;
    if (origin) {
      try {
        const parsed = new URL(origin);
        if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || ![String(config.port), '5173'].includes(parsed.port) || parsed.protocol !== 'http:') throw new Error();
      } catch { res.status(403).json({ error: 'Origin rejected.' }); return; }
    }
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); next();
  });
  // Large valid highlight sets must be exportable in one submission.
  app.use('/api/jobs/:id/render', express.json({ limit: '16mb' }));
  app.use(express.json({ limit: '128kb' }));
  const transcriptUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: TRANSCRIPT_MAX_BYTES, files: 1, fields: 2, fieldSize: 2048 }, fileFilter: (_req, file, callback) => {
    if (!/\.(srt|vtt|json|txt)$/i.test(file.originalname)) callback(new Error('Attach an SRT, VTT, JSON or timestamped TXT transcript.')); else callback(null, true);
  } });
  app.get('/api/analyzer/status', (_req, res) => { res.json({ youtubeConfigured: !!config.youtubeApiKey, twitchConfigured: !!(config.twitchClientId && (config.twitchSecret || config.twitchUserToken)), transcriptModel: config.transcriptOllamaModel }); });
  app.post('/api/analyzer/analyze', transcriptUpload.single('transcript'), async (req, res) => {
    const body = z.object({ input: z.string().trim().min(1).max(512), permission: z.literal('true').optional() }).strict().parse(req.body);
    if (req.file && body.permission !== 'true') throw new Error('Confirm that you have permission to process the supplied transcript.');
    res.setHeader('Cache-Control', 'no-store');
    res.json(await analyzer.analyze(body.input, req.file ? { name: req.file.originalname, text: req.file.buffer.toString('utf8'), permission: true } : undefined));
  });
  const cookie = (header: string | undefined, name: string): string => {
    const value = header?.split(';').map(c => c.trim()).find(c => c.startsWith(`${name}=`))?.slice(name.length + 1) || '';
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : '';
  };
  app.use('/api/twitch/oauth', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.post('/api/twitch/oauth/connect', (req, res) => {
    if (req.headers.origin && req.headers.origin !== oauth.options.appOrigin) throw new Error(`Open ${oauth.options.appOrigin} before connecting Twitch so the OAuth browser cookie matches the callback hostname.`);
    const start = oauth.begin(); res.cookie('twitch_oauth_state', start.browser, { httpOnly: true, sameSite: 'lax', path: '/api/twitch/oauth', maxAge: 600_000 });
    res.json({ url: start.url });
  });
  app.get('/api/twitch/oauth/callback', async (req, res) => {
    const query = z.object({ state: z.string().min(1).max(200), code: z.string().max(2048).optional(), error: z.string().max(200).optional() }).parse(req.query);
    const key = await oauth.finish(query.state, cookie(req.headers.cookie, 'twitch_oauth_state'), query.code || '', !!query.error);
    oauth.disconnect(cookie(req.headers.cookie, 'twitch_session'));
    res.clearCookie('twitch_oauth_state', { path: '/api/twitch/oauth', httpOnly: true, sameSite: 'lax' });
    res.cookie('twitch_session', key, { httpOnly: true, sameSite: 'lax', path: '/api/twitch', maxAge: 86_400_000 });
    res.redirect(303, `${oauth.options.appOrigin}/?twitch=connected`);
  });
  app.get('/api/twitch/oauth/status', (req, res) => { res.json(oauth.status(cookie(req.headers.cookie, 'twitch_session'))); });
  app.post('/api/twitch/oauth/disconnect', (req, res) => {
    oauth.disconnect(cookie(req.headers.cookie, 'twitch_session'));
    res.clearCookie('twitch_session', { path: '/api/twitch', httpOnly: true, sameSite: 'lax' }); res.json({ connected: false });
  });
  app.get('/api/twitch/discover', async (req, res) => { res.json(await twitch.discover(z.string().min(1).max(512).parse(req.query.input))); });
  app.get('/api/twitch/live', async (req, res) => { res.json(await twitch.live(z.string().min(1).max(512).parse(req.query.channel))); });
  function viewer(header: string | undefined): { key: string; userId: string } {
    const key = cookie(header, 'twitch_session'); const status = oauth.status(key);
    if (!status.connected || !status.userId) throw new TwitchApiError('Connect Twitch with your viewer account first.', 401);
    return { key, userId: status.userId };
  }
  app.post('/api/twitch/live/clips', async (req, res) => {
    const auth = viewer(req.headers.cookie);
    const body = z.object({ channel: z.string().min(1).max(512), title: z.string().trim().min(1).max(100), duration: z.number().min(30).max(60).refine(n => Math.abs(n * 10 - Math.round(n * 10)) < 0.00001) }).strict().parse(req.body);
    const clip = await twitchLive.create(auth.userId, async () => {
      const current = await twitch.live(body.channel);
      if (!current.live) throw new TwitchApiError('This channel is offline. Viewer clipping works only during a live stream.', 409);
      const result = await oauth.withToken(auth.key, token => twitch.createLiveClip(current.broadcaster.id, token, body.title, body.duration));
      return { id: result.id, url: `https://clips.twitch.tv/${result.id}`, editUrl: result.edit_url, broadcasterId: current.broadcaster.id, broadcasterName: current.broadcaster.display_name, creatorId: auth.userId, createdAt: new Date().toISOString(), status: 'pending', title: body.title, duration: body.duration, error: null };
    });
    res.status(202).json(clip);
  });
  app.get('/api/twitch/live/clips', (req, res) => { const auth = viewer(req.headers.cookie); res.setHeader('Cache-Control', 'no-store'); res.json(twitchLive.list(auth.userId)); });
  app.get('/api/twitch/live/clips/:id', async (req, res) => { const auth = viewer(req.headers.cookie); res.json(await twitchLive.refresh(clipIdSchema.parse(req.params.id), auth.userId)); });
  const upload = multer({ dest: path.join(root, 'uploads'), limits: { fileSize: config.maxBytes, files: 1, fields: 8, fieldSize: 20000 }, fileFilter: (_req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith('.mp4')) cb(new Error('Upload an MP4 recording.')); else cb(null, true);
  } });
  app.get('/api/health', async (_req, res) => { res.json({ ...await health(), editorDefaults: { durationMode: 'auto', clipCount: config.clipCount, minEngagementScore: config.minEngagementScore ?? 70 } }); });
  app.get('/api/twitch/video', async (req, res) => {
    const input = z.string().min(1).max(512).parse(req.query.input);
    res.json({ vod: await twitch.video(input), access: 'metadata-only', message: 'Public VOD visibility does not grant media access. Upload an authorized recording to begin automatic analysis, or create a clip as an authorized broadcaster/editor.' });
  });
  app.post('/api/twitch/clips', async (req, res) => {
    const input = z.object({ vodId: z.string().regex(/^\d+$/), start: z.number().finite().nonnegative(), end: z.number().finite().positive(), title: z.string().trim().min(1).max(100), permission: z.literal(true) }).parse(req.body);
    res.status(202).json(await twitch.createClip(input));
  });
  app.get('/api/twitch/clips/downloads', async (req, res) => {
    const query = z.object({ broadcasterId: z.string().regex(/^\d+$/), clipId: z.string().regex(/^[\w-]+$/).max(200) }).parse(req.query);
    res.json({ downloads: await twitch.downloads(query.broadcasterId, query.clipId) });
  });
  app.get('/api/jobs', (_req, res) => { res.json([...store.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))); });
  app.get('/api/jobs/:id', (req, res) => { res.json(store.get(String(req.params.id))); });
  app.get('/api/jobs/:id/rights', (req, res) => {
    const job = store.get(String(req.params.id));
    const query = z.object({ platform: z.enum(platforms).optional(), use: z.enum(rightsUses).optional() }).parse(req.query);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ rights: normalizeRights(job.rights), assessment: assessRights(job.rights, { ...(query.platform ? { platform: query.platform } : {}), ...(query.use ? { uses: [query.use] } : {}) }) });
  });
  app.put('/api/jobs/:id/rights', async (req, res) => {
    const job = store.get(String(req.params.id)); const rights = sourceRightsSchema.parse(req.body);
    // Rights can be recorded without invalidating analysis or claiming clearance.
    await store.saveRights(job.id, rights);
    res.json({ rights, assessment: assessRights(rights) });
  });
  async function acceptMedia(file: string, name: string, source: Job['source'], meta: z.infer<typeof uploadMeta>): Promise<Job> {
    const rights = meta.rights ? sourceRightsSchema.parse(JSON.parse(meta.rights)) : normalizeRights(undefined);
    const vodId = meta.vodId ? parseVodId(meta.vodId) : null;
    const prepared = await prepareRecording(file);
    try {
      const media = prepared.media;
      const mediaHash = await hashFile(prepared.file); const id = randomUUID(); await mkdir(store.dir(id), { recursive: true });
      await rename(prepared.file, store.mediaPath(id));
      const job: Job = { id, name: path.basename(name), createdAt: new Date().toISOString(), status: 'uploaded', stage: 'Recording ready', progress: 0, media, mediaHash, source, vodId, vodOffset: meta.vodOffset, highlights: [], outputs: [], warnings: prepared.remuxed ? ['Repackaged MPEG-TS as MP4 without re-encoding the video or audio.'] : [], error: null, renderOptions: null, rights, durationMode: 'auto', clipCount: meta.clipCount ?? config.clipCount, minEngagementScore: meta.minEngagementScore ?? config.minEngagementScore ?? 70, selectionVersion: 2 };
      await store.save(job); return job;
    } finally { if (prepared.file !== file) await rm(prepared.file, { force: true }); }
  }
  app.post('/api/jobs/upload', upload.single('media'), async (req, res) => {
    if (!req.file) throw new Error('Select an MP4 recording.');
    let job: Job;
    try { const meta = uploadMeta.parse(req.body); job = await acceptMedia(req.file.path, req.file.originalname, 'upload', meta); }
    finally { await rm(req.file.path, { force: true }); }
    res.status(201).json(job);
  });
  app.post('/api/jobs/import', async (req, res) => {
    const input = z.object({ url: z.string().url().max(4096), permission: z.literal(true), vodId: z.string().default(''), vodOffset: z.number().finite().nonnegative().default(0), rights: sourceRightsSchema.optional(), ...requestAnalysisSettings.shape }).parse(req.body);
    const file = path.join(root, 'uploads', randomUUID());
    let job: Job;
    try {
      await downloadApproved(input.url, file, config.approvedHosts, config.maxBytes);
      job = await acceptMedia(file, 'approved-recording.mp4', 'approved-url', { vodId: input.vodId, vodOffset: input.vodOffset, permission: 'true', durationMode: input.durationMode, clipCount: input.clipCount, ...(input.minEngagementScore !== undefined ? { minEngagementScore: input.minEngagementScore } : {}), ...(input.rights ? { rights: JSON.stringify(input.rights) } : {}) });
    } finally { await rm(file, { force: true }); }
    res.status(201).json(job);
  });
  app.post('/api/jobs/:id/analyze', async (req, res) => {
    const body = requestAnalysisSettings.parse(req.body || {});
    res.status(202).json(await manager.analyze(String(req.params.id), body));
  });
  app.post('/api/jobs/:id/render', async (req, res) => {
    const body = renderSchema.parse(req.body); res.status(202).json(await manager.render(String(req.params.id), body.clips, body.options));
  });
  app.post('/api/jobs/:id/retention', async (req, res) => {
    const body = z.object({ settings: retentionSettingsSchema, clips: renderSchema.shape.clips.optional() }).parse(req.body);
    res.status(202).json(await manager.regenerate(String(req.params.id), body.settings, body.clips));
  });
  app.get('/api/jobs/:id/transcript', async (req, res) => {
    const job = store.get(String(req.params.id));
    const transcript = await readJson<Transcript>(path.join(store.dir(job.id), 'transcript.json'));
    if (!transcript) { res.status(409).json({ error: 'Analyze the recording first.' }); return; }
    res.json(transcript);
  });
  const audioUpload = multer({ dest: path.join(root, 'uploads'), limits: { fileSize: 100 * 1024 ** 2, files: 1 } });
  app.post('/api/jobs/:id/audio', audioUpload.single('audio'), async (req, res) => {
    if (!req.file) throw new Error('Choose a licensed or user-owned audio file.');
    try {
      const job = store.get(String(req.params.id));
      if (['queued', 'analyzing', 'rendering'].includes(job.status)) throw new Error('Wait for processing before adding audio.');
      if ((job.audioAssets?.length || 0) >= 20) throw new Error('This recording already has 20 audio assets.');
      const meta = z.object({ kind: z.enum(['music', 'sfx']), license: z.enum(['owned', 'licensed']), provenance: z.string().trim().min(5).max(2000), permission: z.literal('true') }).parse(req.body);
      const probe = JSON.parse(await runProcess(config.ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', req.file.path], { timeout: 30000 })) as { streams?: { codec_type: string }[]; format?: { duration?: string } };
      if (!probe.streams?.some(s => s.codec_type === 'audio') || !Number.isFinite(Number(probe.format?.duration)) || Number(probe.format?.duration) <= 0) throw new Error('The uploaded file has no playable audio.');
      const id = randomUUID(); const audioDir = path.join(store.dir(job.id), 'audio'); await mkdir(audioDir, { recursive: true });
      await rename(req.file.path, path.join(audioDir, `${id}.bin`));
      const asset = { id, kind: meta.kind, name: path.basename(req.file.originalname), provenance: meta.provenance, license: meta.license, permission: true as const, addedAt: new Date().toISOString() };
      job.audioAssets = [...job.audioAssets || [], asset]; await store.save(job); res.status(201).json(asset);
    } finally { await rm(req.file.path, { force: true }); }
  });
  app.get('/api/jobs/:id/media', (req, res) => { const job = store.get(String(req.params.id)); res.sendFile(store.mediaPath(job.id)); });
  app.get('/api/jobs/:id/results', (req, res) => {
    const job = store.get(String(req.params.id));
    if (job.status === 'complete') res.download(path.join(store.dir(job.id), 'exports', 'results.json'), 'results.json');
    else if (job.highlights.length || job.status === 'review') res.json({ jobId: job.id, durationMode: 'auto', clipCount: job.clipCount ?? config.clipCount, minEngagementScore: job.minEngagementScore ?? config.minEngagementScore ?? 70, highlights: job.highlights, warnings: job.warnings, vodOffset: job.vodOffset, rights: normalizeRights(job.rights), rightsAssessment: assessRights(job.rights), purpose: 'private-analysis' });
    else res.status(409).json({ error: 'Analysis has not completed.' });
  });
  app.get('/api/jobs/:id/files/:file', (req, res) => {
    const job = store.get(String(req.params.id)); const file = String(req.params.file);
    if (job.status !== 'complete' || !job.outputs.some(c => c.file === file)) { res.status(404).json({ error: 'Export not found.' }); return; }
    res.download(path.join(store.dir(job.id), 'exports', file), file);
  });
  app.get('/api/jobs/:id/preview/:file', (req, res) => {
    const job = store.get(String(req.params.id)); const file = String(req.params.file);
    if (job.status !== 'complete' || !job.outputs.some(c => c.file === file)) { res.status(404).json({ error: 'Export not found.' }); return; }
    res.sendFile(path.join(store.dir(job.id), 'exports', file));
  });
  app.get('/api/jobs/:id/zip', async (req, res, next) => {
    const job = store.get(String(req.params.id)); if (job.status !== 'complete') { res.status(409).json({ error: 'Finish rendering first.' }); return; }
    const dir = path.join(store.dir(job.id), 'exports');
    for (const file of [...job.outputs.map(o => o.file), 'results.json']) await access(path.join(dir, file));
    res.attachment('stream-clips.zip'); const archive = new ZipArchive({ zlib: { level: 1 } });
    archive.on('error', error => { if (res.headersSent) res.destroy(error); else next(error); });
    res.on('close', () => archive.abort()); archive.pipe(res);
    for (const output of job.outputs) {
      archive.file(path.join(dir, output.file), { name: output.file });
      const extensions = job.renderOptions?.retention ? ['.ass', '.edl.json', ...(job.renderOptions.retention.captions.enabled ? ['.srt'] : [])] : job.renderOptions?.subtitles ? ['.srt'] : [];
      for (const extension of extensions) { const sidecar = output.file.replace('.mp4', extension); archive.file(path.join(dir, sidecar), { name: sidecar }); }
    }
    archive.file(path.join(dir, 'results.json'), { name: 'results.json' }); await archive.finalize();
  });
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'API route not found.' }); });
  const client = path.resolve('dist/client'); app.use(express.static(client));
  app.get(/.*/, (_req, res) => { res.sendFile(path.join(client, 'index.html')); });
  const errors: ErrorRequestHandler = (error: unknown, req, res, _next) => {
    if (req.file?.path) void rm(req.file.path, { force: true });
    const message = error instanceof z.ZodError ? 'Invalid request. Check required fields, permission confirmation and timestamp values.' : error instanceof Error ? error.message : 'Request failed.';
    if (res.headersSent) { res.end(); return; }
    const platformError = error instanceof TwitchApiError || error instanceof YouTubeApiError;
    if (platformError && error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
    res.status(platformError ? error.status : message === 'Job not found.' ? 404 : error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: message, ...(platformError && error.retryAfter ? { retryAfter: error.retryAfter } : {}) });
  };
  app.use(errors); return { app, store, manager, oauth, twitchLive };
}
