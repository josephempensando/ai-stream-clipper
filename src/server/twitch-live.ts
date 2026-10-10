import path from 'node:path';
import type { LiveClip } from '../shared/types.js';
import { readJson, writeJson } from './store.js';
import { TwitchClient } from './twitch.js';
import { TwitchApiError } from './twitch-http.js';

/** Saves identifiers/links only. This service never fetches clip video or download URLs. */
export class TwitchLiveStore {
  private clips = new Map<string, LiveClip>();
  private timers = new Map<string, NodeJS.Timeout>();
  private inFlight = new Set<string>();
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly root: string, private readonly twitch: TwitchClient, private readonly now: () => number = Date.now) {}
  async init(): Promise<void> {
    const saved = await readJson<LiveClip[]>(path.join(this.root, 'twitch-live-clips.json')) || [];
    for (const clip of saved) {
      this.clips.set(clip.id, clip);
      if (clip.status === 'pending') this.schedule(clip.id);
    }
  }
  close(): void { for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); }
  list(userId: string): LiveClip[] { return [...this.clips.values()].filter(c => c.creatorId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  private save(): Promise<void> {
    const snapshot = [...this.clips.values()].map(c => ({ ...c }));
    const write = this.writes.catch(() => {}).then(() => writeJson(path.join(this.root, 'twitch-live-clips.json'), snapshot));
    this.writes = write; return write;
  }
  async create(userId: string, work: () => Promise<LiveClip>): Promise<LiveClip> {
    if (this.inFlight.has(userId)) throw new TwitchApiError('A clip request is already running. Wait for its result.', 429, 3);
    this.inFlight.add(userId);
    try {
      const clip = await work(); this.clips.set(clip.id, clip); await this.save(); this.schedule(clip.id); return { ...clip };
    } finally { this.inFlight.delete(userId); }
  }
  private schedule(id: string, delay = 3000): void {
    if (this.timers.has(id)) return;
    const clip = this.clips.get(id); if (!clip || clip.status !== 'pending') return;
    delay = Math.max(1, Math.min(delay, Date.parse(clip.createdAt) + 60_000 - this.now()));
    const timer = setTimeout(() => {
      this.timers.delete(id); const clip = this.clips.get(id); if (!clip || clip.status !== 'pending') return;
      void this.refresh(id, clip.creatorId).then(result => { if (result.status === 'pending') this.schedule(id); }).catch(error => {
        // Poll failures do not fabricate a published clip. A later check may confirm it.
        this.schedule(id, error instanceof TwitchApiError && error.retryAfter ? Math.min(error.retryAfter * 1000, 60_000) : 5000);
      });
    }, delay); timer.unref(); this.timers.set(id, timer);
  }
  async refresh(id: string, userId: string): Promise<LiveClip> {
    const clip = this.clips.get(id);
    if (!clip || clip.creatorId !== userId) throw new TwitchApiError('Saved clip not found for this viewer.', 404);
    if (clip.status !== 'pending') return { ...clip };
    const expired = () => this.now() - Date.parse(clip.createdAt) >= 60_000;
    if (expired()) return this.fail(clip);
    let published;
    try { published = await this.twitch.getPublicClip(id); }
    catch (error) { if (clip.status !== 'pending') return { ...clip }; if (expired()) return this.fail(clip); throw error; }
    if (clip.status !== 'pending') return { ...clip };
    if (expired()) return this.fail(clip);
    if (published && published.broadcaster_id === clip.broadcasterId && published.creator_id === clip.creatorId) {
      clip.status = 'ready'; clip.title = published.title; clip.duration = published.duration;
    }
    if (clip.status !== 'pending') { const timer = this.timers.get(id); if (timer) clearTimeout(timer); this.timers.delete(id); await this.save(); }
    return { ...clip };
  }
  private async fail(clip: LiveClip): Promise<LiveClip> {
    if (clip.status !== 'pending') return { ...clip };
    clip.status = 'failed'; clip.error = 'Twitch did not confirm publication within 60 seconds. The clip may have failed; check Twitch before creating another.';
    const timer = this.timers.get(clip.id); if (timer) clearTimeout(timer); this.timers.delete(clip.id);
    await this.save(); return { ...clip };
  }
}
