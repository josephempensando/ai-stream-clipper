import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Candidate, Highlight, LivestreamSource, TimestampAnalysis, TimestampHighlight } from '../shared/types.js';
import { formatTimestamp, parseLivestreamSource, timestampLink } from '../shared/livestream.js';
import { TwitchClient, parseTwitchDuration } from './twitch.js';
import { rankPublicClips } from './twitch-public.js';
import { YouTubeClient } from './youtube.js';
import { selectHighlights } from './analysis.js';
import { parseTranscript, transcriptCandidates } from './transcripts.js';
import { config } from './config.js';
import { rankBatch } from './models.js';
import { readJson, writeJson } from './store.js';
import { TwitchApiError } from './twitch-http.js';
import { recoverRankings, validateCachedRankings } from './ranking.js';

export interface TranscriptAttachment { name: string; text: string; permission: true }
type RankTranscript = (candidates: Candidate[], onWarning?: (warning: string) => void) => Promise<Highlight[]>;
const selection = (highlights: TimestampHighlight[], count: number) => {
  const byId = new Map(highlights.map(h => [h.id, h]));
  return selectHighlights(highlights.map(h => ({ id: h.id, start: h.start, end: h.end, score: h.score, heuristicScore: 0, title: h.title, explanation: h.description, evidence: [], transcript: h.transcript || '', frameTimes: [] })), count).map(h => byId.get(h.id)!);
};
export class TimestampAnalyzer {
  private activeTranscript = false;
  constructor(private readonly twitch = new TwitchClient(), private readonly youtube = new YouTubeClient(), private readonly root = config.dataDir, private readonly rank: RankTranscript = (cs, onWarning) => rankBatch(cs, [], { model: config.transcriptOllamaModel, transcriptOnly: true, ...(onWarning ? { onWarning } : {}) })) {}
  async analyze(input: string, attachment?: TranscriptAttachment): Promise<TimestampAnalysis> {
    const parsed = parseLivestreamSource(input);
    if (parsed.platform === 'twitch' && !attachment) return this.twitchHighlights(parsed.id);
    const vod = parsed.platform === 'twitch' ? await this.twitch.video(parsed.id) : null;
    const source: LivestreamSource = vod ? { platform: 'twitch', id: vod.id, url: `https://www.twitch.tv/videos/${vod.id}`, title: vod.title, creator: vod.user_name, duration: parseTwitchDuration(vod.duration), viewCount: vod.view_count, thumbnailUrl: '', isLive: false, embedAllowed: true } : await this.youtube.video(parsed.id);
    const base: TimestampAnalysis = { source, status: 'unavailable', highlights: [], dataSource: 'none', confidence: 'unavailable', confidenceExplanation: 'No supported content analysis is available.', warnings: [], analyzedAt: new Date().toISOString(), scan: null };
    if (!attachment) { base.warnings.push('Attach a legitimately obtained timestamped transcript to analyze this YouTube video, or use an authorized recording in the recording workflow. Public metadata alone cannot identify highlight timestamps.'); return base; }
    if (attachment.permission !== true) throw new Error('Confirm permission to process the supplied transcript.');
    if (source.duration === null) { base.warnings.push('The platform has not supplied a known video duration. Wait for the archived video duration before transcript analysis.'); return base; }
    const transcript = parseTranscript(attachment.name, attachment.text, source.duration);
    const candidates = transcriptCandidates(transcript.segments, source.duration);
    base.dataSource = 'transcript'; base.warnings.push(...transcript.warnings);
    if (!candidates.length) { base.warnings.push('The supplied transcript has no supported highlight context. No missing content or timestamps were invented.'); return base; }
    if (this.activeTranscript) throw new TwitchApiError('Another transcript is being ranked locally. Wait for it to finish before retrying.', 429, 10);
    this.activeTranscript = true;
    try {
      const key = createHash('sha256').update(JSON.stringify({ version: 'transcript-natural-ranges-v3', platform: source.platform, video: source.id, duration: source.duration, segments: transcript.segments, model: config.transcriptOllamaModel })).digest('hex');
      const file = path.join(this.root, 'analyzer-cache', `${key}.json`);
      let ranked = await readJson<Highlight[]>(file) || [];
      try { ranked = validateCachedRankings(ranked, candidates, true); }
      catch { ranked = []; base.warnings.push('Invalid cached rankings were discarded and analyzed again.'); }
      const recoveryWarnings = new Set<string>(); let stopped: Error | null = null;
      const missing = candidates.filter(c => !ranked.some(row => row.id === c.id));
      for (let i = 0; i < missing.length && !stopped; i += 3) {
        const recovered = await recoverRankings(missing.slice(i, i + 3), [], cs => this.rank(cs, warning => recoveryWarnings.add(warning)), {
          transcriptOnly: true,
          onWarning: warning => recoveryWarnings.add(warning),
          onAccepted: async rows => { ranked.push(...rows); await writeJson(file, ranked); },
        });
        stopped = recovered.error;
      }
      if (!ranked.length) throw stopped || new Error('Ollama could not return valid transcript timings after smaller requests and retries. Completed rankings are saved; retry or choose a more capable model.');
      ranked = validateCachedRankings(ranked, candidates, true);
      base.warnings.push(...recoveryWarnings);
      if (ranked.length < candidates.length) base.warnings.push(`${candidates.length - ranked.length} reading context(s) could not be analyzed and were skipped. Valid results were retained; analyze again to retry missing work.`);
      if (stopped) base.warnings.push(stopped.message);
      // Preserve the model's strongest complete moments before filling spare slots.
      const best: Highlight[] = [];
      for (const highlight of [...ranked].sort((a, b) => b.score - a.score)) {
        if (best.length === 5) break;
        if (best.every(h => highlight.end <= h.start || highlight.start >= h.end)) best.push(highlight);
      }
      base.highlights = best.map(h => this.output(source, { id: h.id, start: h.start, end: h.end, title: h.title, description: h.explanation, score: h.score, viewCount: null, clipUrl: null, transcript: h.transcript, dataSource: 'transcript', confidence: 'transcript-supported' }));
      base.status = base.highlights.length === 5 && ranked.length === candidates.length ? 'ready' : base.highlights.length ? 'partial' : 'unavailable';
      base.confidence = base.highlights.length ? 'transcript-supported' : 'unavailable';
      base.confidenceExplanation = 'Ollama chooses natural start/end boundaries from user-supplied transcript cues, within the official video duration, without a fixed clip length. Entertainment scores are local-model judgments, not calibrated probabilities. No audiovisual analysis occurred.';
      base.warnings.push('Transcript timing and association with this video are supplied by you; automatic verification against video/audio is unavailable.', 'Analysis samples up to 120 overlapping contexts of about three minutes and 6,000 text characters; longer moments crossing context boundaries may be missed. Short gaps of up to eight seconds may occur inside a context.');
      if (base.highlights.length < 5) base.warnings.push(`Selected ${base.highlights.length} non-overlapping highlights, prioritizing the strongest complete moments over filling five slots.`);
      return base;
    } finally { this.activeTranscript = false; }
  }
  private output(source: LivestreamSource, data: Omit<TimestampHighlight, 'startTime' | 'endTime' | 'duration' | 'originalUrl'>): TimestampHighlight {
    return { ...data, startTime: formatTimestamp(data.start), endTime: formatTimestamp(data.end), duration: data.end - data.start, originalUrl: timestampLink(source.platform, source.id, data.start) };
  }
  private async twitchHighlights(id: string): Promise<TimestampAnalysis> {
    const search = await this.twitch.timestampClips(id); const vod = search.vod; const duration = parseTwitchDuration(vod.duration);
    const source: LivestreamSource = { platform: 'twitch', id: vod.id, url: `https://www.twitch.tv/videos/${vod.id}`, title: vod.title, creator: vod.user_name, duration, viewCount: vod.view_count, thumbnailUrl: '', isLive: false, embedAllowed: true };
    const usable = search.clips.filter(c => c.vod_offset !== null && c.vod_offset + c.duration <= duration);
    const candidates = rankPublicClips(usable).map(c => this.output(source, { id: c.id, start: c.vod_offset!, end: c.vod_offset! + c.duration, title: c.title, description: `${c.explanation} Actual VOD interval is supplied by Twitch${c.duration < 30 ? '; this shorter clip has not been extended' : ''}.`, score: c.score, viewCount: c.view_count, clipUrl: c.url, transcript: null, dataSource: 'existing-clips', confidence: 'metadata-only' }));
    const highlights = selection(candidates, 5);
    const warnings = ['Ranked from public clip popularity, titles and metadata. No full-video/audio AI analysis occurred; entertainment quality is not directly verified.'];
    if (highlights.some(h => h.duration < 30)) warnings.push('Some existing clips are shorter than 30 seconds. Their actual durations are shown; no additional content was analyzed or invented.');
    if (search.truncated) warnings.push('Search reached a pagination limit. Date refinements and available fallback pages were scanned, but other clips may exist.');
    if (highlights.length < 5) warnings.push(`Found ${highlights.length} distinct highlights with known offsets; five genuine timestamps could not be supplied from the returned data.`);
    if (!highlights.length) warnings.push('No usable clips linked to this VOD had a valid start offset and an in-bounds duration. Missing video IDs or offsets were not guessed.');
    return { source, status: highlights.length === 5 ? 'ready' : highlights.length ? 'partial' : 'unavailable', highlights, dataSource: 'existing-clips', confidence: highlights.length ? 'metadata-only' : 'unavailable', confidenceExplanation: 'Twitch Get Clips provides exact start offsets and actual durations. Scores reflect public metadata, not direct content analysis or a probability that a moment is entertaining.', warnings, analyzedAt: new Date().toISOString(), scan: { pages: search.pages, scanned: search.scanned, matched: search.clips.length, missingOffsets: search.clips.filter(c => c.vod_offset === null).length, truncated: search.truncated, dateFiltered: search.dateFiltered } };
  }
}
