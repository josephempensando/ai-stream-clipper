import { z } from 'zod';

export const MAX_HIGHLIGHT_COUNT = 8;
export const analysisSettingsSchema = z.object({
  durationMode: z.literal('auto').default('auto'),
  clipCount: z.union([z.literal('all').transform(() => MAX_HIGHLIGHT_COUNT), z.coerce.number().int().positive().max(MAX_HIGHLIGHT_COUNT)]).default(MAX_HIGHLIGHT_COUNT),
  minEngagementScore: z.coerce.number().finite().min(0).max(100).optional(),
});

export function parseVodId(input: string): string {
  const value = input.trim();
  if (/^\d+$/.test(value)) return value;
  const url = new URL(value.replace(/^https\/\//i, 'https://'));
  const match = /^\/videos\/(\d+)\/?$/.exec(url.pathname);
  const schedule = /^\/[A-Za-z0-9_]{1,25}\/schedule\/?$/.test(url.pathname);
  const queryIds = url.searchParams.getAll('vodID');
  const id = match?.[1] || (schedule && queryIds.length === 1 ? queryIds[0] : null);
  if (url.protocol !== 'https:' || !['twitch.tv', 'www.twitch.tv', 'm.twitch.tv'].includes(url.hostname) || url.username || url.password || url.port || !id || !/^\d+$/.test(id) || queryIds.length > 1 || (match && queryIds.length === 1 && queryIds[0] !== id)) {
    throw new Error('Enter a Twitch VOD URL, a channel schedule URL containing vodID, or a numeric VOD ID.');
  }
  return id;
}
export const renderSchema = z.object({
  clips: z.array(z.object({ id: z.string().min(1), start: z.number().finite().nonnegative(), end: z.number().finite().positive() })).min(1),
  options: z.object({ layout: z.enum(['blur', 'crop']), cropX: z.number().min(0).max(1), subtitles: z.boolean() }),
});
export function validateEdits(clips: { id: string; start: number; end: number }[], duration: number): void {
  if (!clips.length || !Number.isFinite(duration) || duration <= 0) throw new Error('Select at least one clip from a valid recording.');
  const ids = new Set<string>();
  const ordered = [...clips].sort((a, b) => a.start - b.start);
  for (const [index, clip] of ordered.entries()) {
    if (!clip.id || ids.has(clip.id) || !Number.isFinite(clip.start) || !Number.isFinite(clip.end) || clip.start < 0 || clip.end > duration || clip.end <= clip.start) {
      throw new Error('Each clip must have an end after its start, within the recording, with a unique ID.');
    }
    if (index > 0 && clip.start < ordered[index - 1]!.end) throw new Error('Selected clips must not overlap.');
    ids.add(clip.id);
  }
}
