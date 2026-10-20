import path from 'node:path';
import { mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { VoicePreview } from '../../shared/story.js';
import { StoryRequestError } from '../../shared/story.js';
import { Semaphore } from '../process.js';
import { requireVoice } from './voices.js';
import { PiperSynthesizer } from './piper.js';
import { probeAudio } from './audio.js';
import { safePath, containedFile } from './paths.js';
interface PreviewState { job: VoicePreview; controller: AbortController; task: Promise<void> }
export class VoicePreviewManager {
  private readonly queue = new Semaphore(1); private readonly states = new Map<string, PreviewState>(); private count = 0; private closed = false;
  private readonly admissions = new Set<Promise<void>>();
  private readonly timer: NodeJS.Timeout;
  readonly directory: string;
  constructor(root: string) { this.directory = path.resolve(root, 'story-previews'); this.timer = setInterval(() => { for (const [id, state] of this.states) if (Date.parse(state.job.expiresAt) <= Date.now()) void this.cancelAndDelete(id).catch(() => {}); }, 30_000); this.timer.unref(); }
  async init(): Promise<void> { await mkdir(this.directory, { recursive: true }); for (const id of await readdir(this.directory)) if (z.uuid().safeParse(id).success) await rm(safePath(this.directory, id), { recursive: true, force: true }); }
  async create(text: string, voiceId: string, speed: number): Promise<VoicePreview> {
    if (this.closed) throw new StoryRequestError('STORY_CLOSED', 'Voice preview service is shutting down.', 503);
    if (this.count >= 3) throw new StoryRequestError('PREVIEW_QUEUE_FULL', 'Voice preview is busy. Try again shortly.', 429);
    this.count++;
    let finish!: () => void; const admission = new Promise<void>(resolve => { finish = resolve; }); this.admissions.add(admission);
    let directory: string | undefined;
    try {
      const voice = await requireVoice(voiceId); const id = randomUUID(); const controller = new AbortController(); const signal = controller.signal;
      if (this.closed) throw new StoryRequestError('STORY_CLOSED', 'Voice preview service is shutting down.', 503);
      const job: VoicePreview = { id, status: 'queued', expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), error: null };
      directory = safePath(this.directory, id); await mkdir(directory, { recursive: true });
      if (this.closed) throw new StoryRequestError('STORY_CLOSED', 'Voice preview service is shutting down.', 503);
      const ownedDirectory = directory;
      const state: PreviewState = { job, controller, task: Promise.resolve() }; this.states.set(id, state);
      state.task = this.queue.run(async () => {
        job.status = 'synthesizing'; const textFile = path.join(ownedDirectory, 'preview.txt'); const wavFile = path.join(ownedDirectory, 'preview.wav'); await writeFile(textFile, text, 'utf8');
        await new PiperSynthesizer().synthesize({ textFile, wavFile, voice, speed }, signal); const audio = await probeAudio(wavFile, signal); signal.throwIfAborted();
        job.actualDuration = audio.duration; job.audioUrl = `/api/story-videos/voice-previews/${id}/audio`; job.status = 'complete';
      }, signal).catch(() => { job.status = signal.aborted ? 'cancelled' : 'error'; job.error = signal.aborted ? null : { code: 'PIPER_FAILED', message: 'Local voice preview failed. Check Piper and the selected voice model.' }; }).finally(() => { this.count--; });
      return structuredClone(job);
    } catch (error) { this.count--; if (directory) await rm(directory, { recursive: true, force: true }); throw error; }
    finally { this.admissions.delete(admission); finish(); }
  }
  get(id: string): VoicePreview { if (!z.uuid().safeParse(id).success) throw new StoryRequestError('INVALID_PREVIEW', 'Invalid voice preview ID.'); const state = this.states.get(id); if (!state || Date.parse(state.job.expiresAt) <= Date.now()) throw new StoryRequestError('PREVIEW_NOT_FOUND', 'Voice preview expired or does not exist.', 404); return structuredClone(state.job); }
  async audioPath(id: string): Promise<string> { if (this.get(id).status !== 'complete') throw new StoryRequestError('PREVIEW_NOT_READY', 'Voice preview is not ready.', 409); return containedFile(this.directory, path.join(id, 'preview.wav')); }
  async cancelAndDelete(id: string): Promise<void> { if (!z.uuid().safeParse(id).success) throw new StoryRequestError('INVALID_PREVIEW', 'Invalid preview ID.'); const state = this.states.get(id); if (!state) return; state.controller.abort(); await state.task; await rm(safePath(this.directory, id), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); this.states.delete(id); }
  async close(): Promise<void> { this.closed = true; clearInterval(this.timer); for (const state of this.states.values()) state.controller.abort(); await Promise.all(this.admissions); for (const state of this.states.values()) state.controller.abort(); await Promise.all([...this.states.values()].map(s => s.task)); for (const id of this.states.keys()) await rm(safePath(this.directory, id), { recursive: true, force: true, maxRetries: 3 }); this.states.clear(); }
}
