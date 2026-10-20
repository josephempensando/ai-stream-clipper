import { Router, json } from 'express';
import type { ErrorRequestHandler } from 'express';
import multer from 'multer';
import path from 'node:path';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { z } from 'zod';
import { createStorySettingsSchema, voiceIdSchema, StoryRequestError } from '../../shared/story.js';
import { storyConfig } from './config.js';
import { config } from '../config.js';
import { runProcess } from '../process.js';
import { hashFile } from '../store.js';
import { probe } from '../media.js';
import { probeAudio } from './audio.js';
import { getStoryReadiness, requireVoice } from './voices.js';
import { StoryStore } from './store.js';
import { StoryJobManager, type RetainedStoryInput } from './jobs.js';
import { VoicePreviewManager } from './previews.js';
import { createStoryUpload, withStoryUpload } from './uploads.js';
import { safePath } from './paths.js';
export async function createStoryServices(root: string) {
  const store = new StoryStore(root); await store.init(); const jobs = new StoryJobManager(store); const previews = new VoicePreviewManager(root); await previews.init();
  const staging = path.resolve(root, 'story-uploads'); await mkdir(staging, { recursive: true });
  for (const id of await readdir(staging)) if (z.uuid().safeParse(id).success) await rm(safePath(staging, id), { recursive: true, force: true });
  return { store, jobs, previews, close: async () => { await Promise.all([jobs.close(), previews.close()]); } };
}
export type StoryServices = Awaited<ReturnType<typeof createStoryServices>>;
const displayName = (name: string) => path.basename(name.replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 160);
export function createStoryRouter(services: Pick<StoryServices, 'store' | 'jobs' | 'previews'>): Router {
  const router = Router(); const schema = createStorySettingsSchema(storyConfig.maxScriptCharacters);
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Cross-Origin-Resource-Policy', 'same-origin'); next(); });
  router.use(json({ limit: '128kb' }));
  const ready = async (voiceId: string, captions: boolean, signal?: AbortSignal) => {
    await requireVoice(voiceId);
    try { signal?.throwIfAborted(); await runProcess(storyConfig.python, ['-c', 'import piper'], { timeout: 10_000, ...(signal ? { signal } : {}) }); if (captions) await runProcess(config.whisper, ['--help'], { timeout: 10_000, ...(signal ? { signal } : {}) }); }
    catch { throw new StoryRequestError('STORY_SETUP_REQUIRED', 'Install local Piper and Whisper as described in the README before generating narration.', 503); }
  };
  router.get('/voices', async (_req, res) => { res.json(await getStoryReadiness()); });
  router.post('/voice-previews', async (req, res) => {
    const body = z.object({ text: z.string().trim().min(1).max(300).refine(t => !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(t)), voiceId: voiceIdSchema, speed: z.number().min(0.75).max(1.5) }).strict().parse(req.body);
    await ready(body.voiceId, false); res.status(202).json(await services.previews.create(body.text, body.voiceId, body.speed));
  });
  router.get('/voice-previews/:id', (req, res) => { res.json(services.previews.get(String(req.params.id))); });
  router.get('/voice-previews/:id/audio', async (req, res) => { res.type('wav').sendFile(await services.previews.audioPath(String(req.params.id))); });
  router.delete('/voice-previews/:id', async (req, res) => { await services.previews.cancelAndDelete(String(req.params.id)); res.status(204).end(); });
  router.get('/', (_req, res) => { res.json(services.jobs.list()); });
  router.post('/', createStoryUpload(services.store.root), async (req, res) => withStoryUpload(req, async signal => {
    z.object({ settings: z.string() }).strict().parse(req.body); const settings = schema.parse(JSON.parse(req.body.settings));
    const files = req.files as Record<string, Express.Multer.File[]>; const video = files.background?.[0]; const music = files.music?.[0];
    if (!video) throw new StoryRequestError('VIDEO_REQUIRED', 'Upload an MP4 background video.');
    if (music && !settings.rights.music?.permission) throw new StoryRequestError('MUSIC_PERMISSION_REQUIRED', 'Confirm music permission, license and provenance.');
    let videoInfo: Awaited<ReturnType<typeof probe>>;
    try { videoInfo = await probe(video.path, signal); } catch { signal.throwIfAborted(); throw new StoryRequestError('INVALID_VIDEO', 'The background must be a readable MP4 containing a video track.'); }
    let musicInfo: Awaited<ReturnType<typeof probeAudio>> | undefined;
    if (music) { try { musicInfo = await probeAudio(music.path, signal); } catch { signal.throwIfAborted(); throw new StoryRequestError('INVALID_MUSIC', 'The music file has no readable audio track.'); } }
    await ready(settings.voiceId, settings.subtitles.enabled, signal); signal.throwIfAborted();
    const retainedVideo: RetainedStoryInput = { file: video.path, originalName: displayName(video.originalname), hash: await hashFile(video.path, signal), ...videoInfo };
    const retainedMusic = music && musicInfo ? { file: music.path, originalName: displayName(music.originalname), hash: await hashFile(music.path, signal), duration: musicInfo.duration, hasAudio: true } : undefined;
    signal.throwIfAborted(); const job = await services.jobs.create({ video: retainedVideo, ...(retainedMusic ? { music: retainedMusic } : {}) }, settings, signal);
    if (signal.aborted) { await services.jobs.cancel(job.id); signal.throwIfAborted(); }
    res.status(202).json(job);
  }));
  router.get('/:id', (req, res) => { res.json(services.jobs.get(String(req.params.id))); });
  router.post('/:id/cancel', async (req, res) => { res.json(await services.jobs.cancel(String(req.params.id))); });
  router.post('/:id/regenerate', async (req, res) => { const settings = schema.parse(req.body); services.jobs.get(String(req.params.id)); await ready(settings.voiceId, settings.subtitles.enabled); res.status(202).json(await services.jobs.regenerate(String(req.params.id), settings)); });
  router.get('/:id/preview', async (req, res) => { res.type('mp4').sendFile(await services.store.artifactPath(String(req.params.id), 'video.mp4')); });
  router.get('/:id/download', async (req, res) => { const id = String(req.params.id); res.download(await services.store.artifactPath(id, 'video.mp4'), `cutline-story-${id}.mp4`); });
  router.get('/:id/captions', async (req, res) => { const id = String(req.params.id); res.download(await services.store.artifactPath(id, 'captions.srt'), `cutline-story-${id}.srt`); });
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (res.headersSent) { res.end(); return; }
    const size = error instanceof multer.MulterError && ['LIMIT_FILE_SIZE', 'LIMIT_FIELD_VALUE'].includes(error.code) || (error as { type?: string })?.type === 'entity.too.large';
    const status = error instanceof StoryRequestError ? error.status : size ? 413 : 400;
    res.status(status).json({ error: error instanceof StoryRequestError ? error.message : size ? 'Upload is too large. Music must be under 100 MiB; check the configured video limit.' : 'Invalid story request. Check script, MP4, settings and permission confirmations.', code: error instanceof StoryRequestError ? error.code : size ? 'UPLOAD_TOO_LARGE' : 'INVALID_STORY_REQUEST' });
  };
  router.use(errors); return router;
}
