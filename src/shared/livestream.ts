import { parseVodId } from './validation.js';
import type { TimestampAnalysis } from './types.js';

export function parseLivestreamSource(input: string): { platform: 'twitch' | 'youtube'; id: string; url: string } {
  const value = input.trim().replace(/^https\/\//i, 'https://');
  if (/^\d+$/.test(value)) { const id = parseVodId(value); return { platform: 'twitch', id, url: `https://www.twitch.tv/videos/${id}` }; }
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Enter a Twitch VOD/schedule URL or a YouTube watch/live/youtu.be URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('Use an official HTTPS Twitch or YouTube URL without credentials or custom ports.');
  if (['twitch.tv', 'www.twitch.tv', 'm.twitch.tv'].includes(url.hostname)) {
    const id = parseVodId(value); return { platform: 'twitch', id, url: `https://www.twitch.tv/videos/${id}` };
  }
  let id: string | null = null;
  if (url.hostname === 'youtu.be') id = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1] || null;
  else if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) {
    if (url.pathname === '/watch' && url.searchParams.getAll('v').length === 1) id = url.searchParams.get('v');
    else id = /^\/live\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1] || null;
  }
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id) || url.searchParams.getAll('v').length > 1 || (url.searchParams.has('v') && url.searchParams.get('v') !== id)) throw new Error('Enter an official YouTube watch, live or youtu.be video URL.');
  return { platform: 'youtube', id, url: `https://www.youtube.com/watch?v=${id}` };
}
export function formatTimestamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Invalid timestamp.');
  const ms = Math.round(seconds * 1000); const whole = Math.floor(ms / 1000);
  const base = [Math.floor(whole / 3600), Math.floor(whole / 60) % 60, whole % 60].map(n => String(n).padStart(2, '0')).join(':');
  return ms % 1000 ? `${base}.${String(ms % 1000).padStart(3, '0').replace(/0+$/, '')}` : base;
}
export function timestampLink(platform: 'twitch' | 'youtube', id: string, seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Invalid seek time.');
  const n = Math.floor(seconds);
  if (platform === 'twitch') {
    if (!/^\d+$/.test(id)) throw new Error('Invalid Twitch video ID.');
    return `https://www.twitch.tv/videos/${id}?t=${Math.floor(n / 3600)}h${Math.floor(n / 60) % 60}m${n % 60}s`;
  }
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error('Invalid YouTube video ID.');
  return `https://www.youtube.com/watch?v=${id}&t=${n}s`;
}
export function allTimestamps(analysis: TimestampAnalysis): string {
  return [analysis.source.title, analysis.source.url, `Data source: ${analysis.dataSource}`, ...analysis.highlights.map((h, i) => `${i + 1}. ${h.startTime} – ${h.endTime} (${h.duration.toFixed(3).replace(/\.?0+$/, '')}s) · ${h.title}\n${h.description}\n${h.originalUrl}${h.clipUrl ? `\nClip: ${h.clipUrl}` : ''}`)].join('\n\n');
}
export function analysisCsv(analysis: TimestampAnalysis): string {
  const cell = (value: unknown): string => {
    let text = value == null ? '' : String(value);
    if (/^[\s\uFEFF]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const columns = ['rank', 'platform', 'video_id', 'start_seconds', 'end_seconds', 'start', 'end', 'duration', 'title', 'description', 'score', 'view_count', 'clip_url', 'original_url', 'data_source', 'confidence'];
  const rows = analysis.highlights.map((h, i) => [i + 1, analysis.source.platform, analysis.source.id, h.start, h.end, h.startTime, h.endTime, h.duration, h.title, h.description, h.score, h.viewCount, h.clipUrl, h.originalUrl, h.dataSource, h.confidence]);
  return [columns.map(cell).join(','), ...rows.map(row => row.map(cell).join(','))].join('\r\n') + '\r\n';
}
