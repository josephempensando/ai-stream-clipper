import { z } from 'zod';
import type { PublicClip, RankedPublicClip } from '../shared/types.js';

export const clipIdSchema = z.string().regex(/^[A-Za-z0-9_-]+$/).min(1).max(200);
export const twitchLinkSchema = z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.port && ['clips.twitch.tv', 'www.twitch.tv', 'twitch.tv'].includes(url.hostname);
}, 'Expected an official Twitch HTTPS link.');
const thumbnail = z.string().refine(value => {
  if (!value) return true; try {
    const url = new URL(value);
    const official = ['clips-media-assets.twitch.tv', 'clips-media-assets2.twitch.tv'].includes(url.hostname) || ['jtvnw.net', 'twitchcdn.net'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && official;
  } catch { return false; }
});
export const publicClipSchema = z.object({
  id: clipIdSchema, url: twitchLinkSchema, embed_url: twitchLinkSchema,
  broadcaster_id: z.string(), broadcaster_name: z.string(), creator_id: z.string(), creator_name: z.string(),
  video_id: z.string().default(''), game_id: z.string(), language: z.string(), title: z.string(),
  view_count: z.number().finite().nonnegative(), created_at: z.string(), thumbnail_url: thumbnail,
  duration: z.number().finite().positive(), vod_offset: z.number().finite().nonnegative().nullable().default(null),
});
export const clipsPageSchema = z.object({ data: z.array(publicClipSchema), pagination: z.object({ cursor: z.string().optional() }).default({}) });
export function rankPublicClips(clips: PublicClip[]): RankedPublicClip[] {
  return clips.map(clip => {
    const titleEvidence = /laugh|funny|fail|unexpected|surprise|reaction|scream|clutch|win|rage|no way|what|insane|wild/i.test(clip.title);
    const descriptive = clip.title.trim().split(/\s+/).length >= 3;
    const score = Math.min(100, Math.round(Math.log10(clip.view_count + 1) * 14 + (titleEvidence ? 12 : 0) + (descriptive ? 5 : 0)));
    return { ...clip, score, explanation: `${clip.view_count.toLocaleString('en-US')} public views${titleEvidence ? '; reaction or highlight wording in the title' : ''}${descriptive ? '; descriptive title' : ''}. Metadata heuristic; content quality is unverified.` };
  }).sort((a, b) => b.score - a.score || b.view_count - a.view_count || a.id.localeCompare(b.id));
}
export function parseChannelLogin(input: string): string {
  let login = input.trim();
  if (login.includes('://')) {
    const url = new URL(login);
    if (url.protocol !== 'https:' || !['www.twitch.tv', 'twitch.tv', 'm.twitch.tv'].includes(url.hostname) || url.username || url.password || url.port || url.search || url.hash || !/^\/[\w]{1,25}\/?$/.test(url.pathname)) throw new Error('Enter a Twitch channel URL or login such as caseoh_ or KaiCenat.');
    login = url.pathname.replaceAll('/', '');
  }
  if (!/^[A-Za-z0-9_]{1,25}$/.test(login) || ['videos', 'directory', 'downloads', 'settings', 'login', 'signup'].includes(login.toLowerCase())) throw new Error('Enter a Twitch channel login or profile URL. VOD URLs belong in discovery mode.');
  return login.toLowerCase();
}
