import { z } from 'zod';
import type { Vod, ClipDiscovery, LiveStatus } from '../shared/types.js';
import { parseVodId, validateEdits } from '../shared/validation.js';
import { config } from './config.js';
import { TwitchHttp } from './twitch-http.js';
import { clipsPageSchema, parseChannelLogin, rankPublicClips, twitchLinkSchema, clipIdSchema } from './twitch-public.js';

interface Credentials { clientId: string; secret: string; userToken: string }
const tokenSchema = z.object({ client_id: z.string(), user_id: z.string(), scopes: z.array(z.string()), expires_in: z.number().positive() });
const vodSchema = z.object({ id: z.string(), title: z.string(), user_id: z.string(), user_name: z.string(), duration: z.string(), thumbnail_url: z.string(), url: z.string(), created_at: z.string(), view_count: z.number() });
const link = z.string().url().refine(s => new URL(s).protocol === 'https:');
const downloadsSchema = z.object({ data: z.array(z.object({ clip_id: z.string(), landscape_download_url: link.nullable(), portrait_download_url: link.nullable() })) });
export class TwitchClient {
  private appToken = ''; private expires = 0;
  private readonly http: TwitchHttp;
  constructor(private readonly credentials: Credentials = { clientId: config.twitchClientId, secret: config.twitchSecret, userToken: config.twitchUserToken }, request: typeof fetch = fetch) { this.http = new TwitchHttp(request); }
  private async call(url: string | URL, init: RequestInit = {}): Promise<unknown> {
    return this.http.call(url, init);
  }
  private async metadataToken(): Promise<string> {
    if (!this.credentials.clientId) throw new Error('Set TWITCH_CLIENT_ID and OAuth credentials in server .env to look up metadata.');
    if (this.credentials.userToken) return this.credentials.userToken;
    if (this.appToken && Date.now() < this.expires) return this.appToken;
    if (!this.credentials.secret) throw new Error('Set TWITCH_CLIENT_SECRET or TWITCH_USER_ACCESS_TOKEN.');
    const result = z.object({ access_token: z.string(), expires_in: z.number() }).parse(await this.call('https://id.twitch.tv/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.credentials.clientId, client_secret: this.credentials.secret, grant_type: 'client_credentials' }),
    }));
    this.appToken = result.access_token; this.expires = Date.now() + (result.expires_in - 60) * 1000; return this.appToken;
  }
  private headers(token: string): Record<string, string> { return { Authorization: `Bearer ${token}`, 'Client-Id': this.credentials.clientId }; }
  async video(input: string): Promise<Vod> {
    const id = parseVodId(input); const token = await this.metadataToken();
    const data = z.object({ data: z.array(vodSchema) }).parse(await this.call(`https://api.twitch.tv/helix/videos?id=${id}`, { headers: this.headers(token) }));
    if (!data.data[0] || data.data[0].id !== id) throw new Error('VOD was not found or is unavailable.'); return data.data[0];
  }
  private async publicGet(endpoint: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(`https://api.twitch.tv/helix/${endpoint}`); url.search = new URLSearchParams(params).toString();
    return this.call(url, { headers: this.headers(await this.metadataToken()) });
  }
  async discover(input: string): Promise<ClipDiscovery> {
    const vod = await this.video(input); const clips = new Map<string, z.infer<typeof clipsPageSchema>['data'][number]>();
    const cursors = new Set<string>(); let cursor = ''; let pages = 0; let scanned = 0; let truncated = false;
    do {
      const page = clipsPageSchema.parse(await this.publicGet('clips', { broadcaster_id: vod.user_id, first: '100', ...(cursor ? { after: cursor } : {}) }));
      pages++; scanned += page.data.length;
      for (const clip of page.data) if (clip.video_id === vod.id && clip.broadcaster_id === vod.user_id && !clips.has(clip.id)) clips.set(clip.id, clip);
      cursor = page.pagination.cursor || '';
      if (cursor && (cursors.has(cursor) || pages >= 10)) { truncated = true; break; }
      cursors.add(cursor);
    } while (cursor);
    const eligible = [...clips.values()].filter(c => c.duration >= 30 && c.duration <= 60);
    const selected = rankPublicClips(eligible).slice(0, 5);
    return { vod, clips: selected, scanned, pages, matched: clips.size, eligible: eligible.length, truncated, analysis: 'public-metadata',
      message: `${selected.length} eligible clip${selected.length === 1 ? '' : 's'} selected from ${eligible.length} found for this VOD. Public metadata ranking only; no video/audio AI analysis. ${truncated ? 'Search stopped at the pagination limit or a repeated cursor; more clips may exist.' : 'Search completed within Twitch’s available pagination.'} Clips without a video_id cannot be matched.` };
  }
  async timestampClips(input: string) {
    const vod = await this.video(input); const duration = parseTwitchDuration(vod.duration);
    const clips = new Map<string, z.infer<typeof clipsPageSchema>['data'][number]>();
    let pages = 0; let scanned = 0; let truncated = false; let dateFiltered = false;
    const scan = async (range: Record<string, string>, maxPages: number): Promise<boolean> => {
      let cursor = ''; const cursors = new Set<string>(); let limited = false; let rangeScanned = 0;
      for (let pageIndex = 0; pageIndex < maxPages && pages < 30; pageIndex++) {
        const page = clipsPageSchema.parse(await this.publicGet('clips', { broadcaster_id: vod.user_id, first: '100', ...range, ...(cursor ? { after: cursor } : {}) }));
        pages++; scanned += page.data.length; rangeScanned += page.data.length;
        for (const c of page.data) if (c.video_id === vod.id && c.broadcaster_id === vod.user_id && !clips.has(c.id)) clips.set(c.id, c);
        cursor = page.pagination.cursor || '';
        // Twitch can omit the final cursor at its approximate 1,000-result cap.
        if (!cursor) { limited = rangeScanned >= 1000; break; }
        if (cursors.has(cursor) || pageIndex + 1 === maxPages || pages === 30) { limited = true; break; }
        cursors.add(cursor);
      }
      truncated ||= limited; return limited;
    };
    const timestamp = Date.parse(vod.created_at);
    if (Number.isFinite(timestamp)) {
      dateFiltered = true;
      const start = Math.max(0, timestamp - 60_000); const end = timestamp + (duration + 86_400) * 1000;
      const range = (s: number, e: number) => ({ started_at: new Date(s).toISOString(), ended_at: new Date(e).toISOString() });
      const limited = await scan(range(start, end), 10);
      if (limited) {
        // Smaller creation-date windows can recover records hidden by Twitch's ~1,000-result limit.
        for (let s = start; s < end && pages < 25; s += 6 * 3600_000) await scan(range(s, Math.min(end, s + 6 * 3600_000)), Math.min(5, 25 - pages));
      }
    }
    const longs = [...clips.values()].filter(c => c.vod_offset !== null && c.duration >= 30 && c.duration <= 60 && c.vod_offset + c.duration <= duration).sort((a, b) => a.vod_offset! + a.duration - b.vod_offset! - b.duration);
    let distinct = 0; let lastEnd = -1;
    for (const c of longs) if (c.vod_offset! >= lastEnd) { distinct++; lastEnd = c.vod_offset! + c.duration; }
    // Clips can be created well after a VOD. Search all available dates when the narrow scan is insufficient.
    if ((!dateFiltered || distinct < 5) && pages < 30) await scan({}, Math.min(10, 30 - pages));
    return { vod, clips: [...clips.values()], pages, scanned, truncated, dateFiltered };
  }
  async live(input: string): Promise<LiveStatus> {
    const login = parseChannelLogin(input);
    const user = z.object({ data: z.array(z.object({ id: z.string().regex(/^\d+$/), login: z.string(), display_name: z.string() })) }).parse(await this.publicGet('users', { login })).data[0];
    if (!user) throw new Error('Twitch channel was not found.');
    const stream = z.object({ data: z.array(z.object({ id: z.string(), title: z.string(), viewer_count: z.number(), started_at: z.string(), game_name: z.string() })) }).parse(await this.publicGet('streams', { user_id: user.id })).data[0] || null;
    return { broadcaster: user, live: !!stream, stream };
  }
  async createLiveClip(broadcasterId: string, userToken: string, title: string, duration: number) {
    z.string().regex(/^\d+$/).parse(broadcasterId); z.number().min(30).max(60).refine(n => Math.abs(n * 10 - Math.round(n * 10)) < 0.00001).parse(duration);
    z.string().trim().min(1).max(100).parse(title);
    const url = new URL('https://api.twitch.tv/helix/clips');
    url.search = new URLSearchParams({ broadcaster_id: broadcasterId, title, duration: String(duration) }).toString();
    const result = z.object({ data: z.array(z.object({ id: clipIdSchema, edit_url: twitchLinkSchema })) }).parse(await this.call(url, { method: 'POST', headers: this.headers(userToken) })).data[0];
    if (!result) throw new Error('Twitch did not return a clip ID.'); return result;
  }
  async getPublicClip(id: string) {
    clipIdSchema.parse(id); return clipsPageSchema.parse(await this.publicGet('clips', { id })).data[0] || null;
  }
  private async authorization(broadcasterId: string): Promise<string> {
    if (!this.credentials.userToken) throw new Error('Authorized clipping requires a broadcaster/editor user OAuth token on the server.');
    const auth = tokenSchema.parse(await this.call('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${this.credentials.userToken}` } }));
    if (auth.client_id !== this.credentials.clientId) throw new Error('Twitch token belongs to a different client.');
    const scope = auth.user_id === broadcasterId ? 'channel:manage:clips' : 'editor:manage:clips';
    const permitted = auth.scopes.includes(scope) || (auth.user_id === broadcasterId && auth.scopes.includes('editor:manage:clips'));
    if (!permitted) throw new Error(`Twitch token requires ${scope}. Channel editor membership is enforced by Twitch.`);
    return auth.user_id;
  }
  async createClip(input: { vodId: string; start: number; end: number; title: string }): Promise<{ id: string; edit_url: string; broadcasterId: string }> {
    const vod = await this.video(input.vodId);
    const duration = parseTwitchDuration(vod.duration);
    validateEdits([{ id: 'manual', start: input.start, end: input.end }], duration);
    if (input.end - input.start < 30 || input.end - input.start > 60) throw new Error('Twitch API clips must be 30–60 seconds.');
    if (!Number.isInteger(input.end) || Math.abs((input.end - input.start) * 10 - Math.round((input.end - input.start) * 10)) > 0.00001) throw new Error('Twitch clip end must be an integer second and duration must have 0.1-second precision.');
    const editor = await this.authorization(vod.user_id);
    const url = new URL('https://api.twitch.tv/helix/videos/clips');
    url.search = new URLSearchParams({ editor_id: editor, broadcaster_id: vod.user_id, vod_id: vod.id, vod_offset: String(input.end), duration: String(input.end - input.start), title: input.title }).toString();
    const result = z.object({ data: z.array(z.object({ id: z.string(), edit_url: link })) }).parse(await this.call(url, { method: 'POST', headers: this.headers(this.credentials.userToken) }));
    if (!result.data[0]) throw new Error('Twitch did not return a clip ID.');
    return { ...result.data[0], broadcasterId: vod.user_id };
  }
  async downloads(broadcasterId: string, clipId: string) {
    const editor = await this.authorization(broadcasterId);
    const url = new URL('https://api.twitch.tv/helix/clips/downloads');
    url.search = new URLSearchParams({ editor_id: editor, broadcaster_id: broadcasterId, clip_id: clipId }).toString();
    return downloadsSchema.parse(await this.call(url, { headers: this.headers(this.credentials.userToken) })).data;
  }
}
export function parseTwitchDuration(value: string): number {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  if (!match || !value) throw new Error('Invalid Twitch duration.');
  return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
}
