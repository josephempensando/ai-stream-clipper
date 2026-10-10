import { z } from 'zod';
import { config } from './config.js';
import type { LivestreamSource } from '../shared/types.js';

export class YouTubeApiError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfter = 0) { super(message); }
}
export function parseYouTubeDuration(value: string): number {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!match || !match.slice(1).some(Boolean)) throw new Error('YouTube did not supply a usable video duration.');
  return Number(match[1] || 0) * 86_400 + Number(match[2] || 0) * 3600 + Number(match[3] || 0) * 60 + Number(match[4] || 0);
}
const videoSchema = z.object({
  id: z.string(), snippet: z.object({ title: z.string(), channelTitle: z.string(), liveBroadcastContent: z.string().optional() }),
  contentDetails: z.object({ duration: z.string() }), statistics: z.object({ viewCount: z.string().optional() }).optional(),
  status: z.object({ embeddable: z.boolean().optional(), privacyStatus: z.string().optional() }).optional(),
});
export class YouTubeClient {
  constructor(private readonly key = config.youtubeApiKey, private readonly request: typeof fetch = fetch) {}
  async video(id: string): Promise<LivestreamSource> {
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error('Invalid YouTube video ID.');
    if (!this.key) throw new Error('Set YOUTUBE_API_KEY in the server .env and enable YouTube Data API v3 to retrieve public video metadata.');
    const url = new URL('https://www.googleapis.com/youtube/v3/videos');
    url.search = new URLSearchParams({ part: 'snippet,contentDetails,statistics,status,liveStreamingDetails', id, key: this.key }).toString();
    let response: Response;
    try { response = await this.request(url, { redirect: 'error', signal: AbortSignal.timeout(20_000) }); }
    catch { throw new YouTubeApiError('YouTube metadata request could not connect. Try again later.', 502); }
    if (!response.ok) {
      const message = response.status === 403 ? 'YouTube API key, API enablement or quota prevents metadata access. Check server configuration and quota.' : response.status === 429 ? 'YouTube rate limit reached. Wait before retrying.' : response.status === 404 ? 'YouTube video was not found or is unavailable.' : `YouTube metadata returned ${response.status}. Check API access and video availability.`;
      throw new YouTubeApiError(message, response.status, response.status === 429 ? Math.max(1, Number(response.headers.get('Retry-After')) || 60) : 0);
    }
    const video = z.object({ items: z.array(videoSchema) }).parse(await response.json()).items.find(v => v.id === id);
    if (!video || video.status?.privacyStatus === 'private') throw new YouTubeApiError('YouTube video was not found or is unavailable with public API access.', 404);
    const seconds = parseYouTubeDuration(video.contentDetails.duration);
    const views = video.statistics?.viewCount === undefined ? null : Number(video.statistics.viewCount);
    return { platform: 'youtube', id, url: `https://www.youtube.com/watch?v=${id}`, title: video.snippet.title, creator: video.snippet.channelTitle, duration: seconds > 0 ? seconds : null, viewCount: views !== null && Number.isFinite(views) ? views : null, thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, isLive: video.snippet.liveBroadcastContent === 'live', embedAllowed: video.status?.embeddable === true };
  }
}
