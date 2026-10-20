import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Candidate, Highlight, LivestreamSource, TimestampAnalysis, TimestampHighlight } from '../shared/types.js';
import { formatTimestamp, parseLivestreamSource, timestampLink } from '../shared/livestream.js';
import { TwitchClient, parseTwitchDuration } from './twitch.js';
import { rankPublicClips } from './twitch-public.js';
import { YouTubeClient } from './youtube.js';
import { selectBestHighlights, shortlistContexts } from './analysis.js';
import { parseTranscript, transcriptContexts } from './transcripts.js';
import { config } from './config.js';
import { rankBatch } from './models.js';
import { readJson, writeJson } from './store.js';
import { TwitchApiError } from './twitch-http.js';
import { recoverRankings, validateCachedRankings, rankingDecisions } from './ranking.js';

export interface TranscriptAttachment { name: string; text: string; permission: true }
type RankTranscript = (candidates: Candidate[], onWarning?: (warning: string) => void) => Promise<Highlight[]>;
const selection = (highlights: TimestampHighlight[]) => {
  const byId = new Map(highlights.map(h => [h.id, h]));
  return selectBestHighlights(highlights.map(h => ({ id: h.id, start: h.start, end: h.end, score: h.score, heuristicScore: 0, title: h.title, explanation: h.description, evidence: [], transcript: h.transcript || '', frameTimes: [] })), config.clipCount, 0, 0).map(h => byId.get(h.id)!);
};
export class TimestampAnalyzer {
  private activeTranscript = false;
  constructor(private readonly twitch = new TwitchClient(), private readonly youtube = new YouTubeClient(), private readonly root = config.dataDir, private readonly rank: RankTranscript = (cs, onWarning) => rankBatch(cs, [], { model: config.transcriptOllamaModel, transcriptOnly: true, durationMode: 'auto', ...(onWarning ? { onWarning } : {}) })) {}
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
    const contexts = transcriptContexts(transcript.segments, source.duration);
    const candidates = shortlistContexts(contexts, config.highlightContextBudget);
    base.dataSource = 'transcript'; base.warnings.push(...transcript.warnings);
    if (!candidates.length) { base.warnings.push('The supplied transcript has no supported highlight context. No missing content or timestamps were invented.'); return base; }
    if (this.activeTranscript) throw new TwitchApiError('Another transcript is being ranked locally. Wait for it to finish before retrying.', 429, 10);
    this.activeTranscript = true;
    try {
      const key = createHash('sha256').update(JSON.stringify({ version: 'transcript-shortlist-v2-min-30', budget: config.highlightContextBudget, platform: source.platform, video: source.id, duration: source.duration, segments: transcript.segments, model: config.transcriptOllamaModel, maxSilenceSeconds: config.maxHighlightSilenceSeconds })).digest('hex');
      const cache = path.join(this.root, 'analyzer-cache', key);
      const ranked: Highlight[] = [];
      const recoveryWarnings = new Set<string>(); let stopped: Error | null = null; let reviewedCount = 0;
      for (let i = 0; i < candidates.length; i += 3) {
        const batch = candidates.slice(i, i + 3).map(context => context.materialize());
        const file = path.join(cache, `ranking-${i}.json`);
        const saved = await readJson<{ rankings: Highlight[]; reviewed: string[] }>(file);
        let rows = saved?.rankings || []; let reviewed = saved?.reviewed || [];
        try {
          if (!Array.isArray(reviewed) || reviewed.some(id => !batch.some(c => c.id === id))) throw new Error('Invalid reviewed context IDs.');
          rows = validateCachedRankings(rows, batch, true, true);
        } catch { rows = []; reviewed = []; recoveryWarnings.add('Invalid cached rankings were discarded and analyzed again.'); }
        const persist = () => writeJson(file, { rankings: rankingDecisions(rows), reviewed });
        const missing = batch.filter(c => !reviewed.includes(c.id) && !rows.some(row => row.id === c.id));
        if (missing.length && !stopped) {
          const recovered = await recoverRankings(missing, [], cs => this.rank(cs, warning => recoveryWarnings.add(warning)), {
            transcriptOnly: true, durationMode: 'auto',
            onWarning: warning => recoveryWarnings.add(warning),
            onAccepted: async accepted => { rows.push(...accepted); await persist(); },
            onReviewed: async ids => { reviewed = [...new Set([...reviewed, ...ids])]; await persist(); },
          });
          stopped = recovered.error;
        }
        ranked.push(...rows);
        reviewedCount += new Set([...reviewed, ...rows.map(h => h.id)]).size;
      }
      if (!ranked.length && !reviewedCount) throw stopped || new Error('Ollama could not return valid transcript timings after smaller requests and retries. Completed rankings are saved; retry or choose a more capable model.');
      base.warnings.push(...recoveryWarnings);
      if (reviewedCount < candidates.length) base.warnings.push(`${candidates.length - reviewedCount} reading context(s) could not be analyzed and were skipped. Valid results were retained; analyze again to retry missing work.`);
      if (stopped) base.warnings.push(stopped.message);
      const best = selectBestHighlights(ranked, config.clipCount, config.minEngagementScore ?? 70);
      base.highlights = best.map(h => this.output(source, { id: h.id, start: h.start, end: h.end, title: h.title, description: h.explanation, score: h.score, viewCount: null, clipUrl: null, transcript: h.transcript, dataSource: 'transcript', confidence: 'transcript-supported' }));
      base.status = base.highlights.length && reviewedCount === candidates.length ? 'ready' : base.highlights.length ? 'partial' : 'unavailable';
      base.confidence = base.highlights.length ? 'transcript-supported' : 'unavailable';
      base.confidenceExplanation = 'Ollama chooses natural start/end boundaries from user-supplied transcript cues, within the official video duration. Highlights require at least 30 meaningful seconds with no maximum duration; shorter candidates without valuable context are rejected. Entertainment scores are local-model judgments, not calibrated probabilities. No audiovisual analysis occurred.';
      if (!base.highlights.length) base.warnings.push('No meaningful 30-second highlight met the selection criteria. No filler was added.');
      base.warnings.push('Transcript timing and association with this video are supplied by you; automatic verification against video/audio is unavailable.', `For faster analysis, shortlisted ${candidates.length} of ${contexts.length} reading contexts across the transcript. Up to ${config.clipCount} non-overlapping moments meeting ${config.minEngagementScore ?? 70}/100 engagement are retained. Shortlisting and model input boundaries can miss moments; scores require human review.`);
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
    const highlights = selection(candidates);
    const warnings = ['Ranked from public clip popularity, titles and metadata. No full-video/audio AI analysis occurred; entertainment quality is not directly verified.'];
    if (highlights.some(h => h.duration < 30)) warnings.push('Some existing clips are shorter than 30 seconds. Their actual durations are shown; no additional content was analyzed or invented.');
    if (search.truncated) warnings.push('Search reached a pagination limit. Date refinements and available fallback pages were scanned, but other clips may exist.');
    if (!highlights.length) warnings.push('No usable clips linked to this VOD had a valid start offset and an in-bounds duration. Missing video IDs or offsets were not guessed.');
    return { source, status: !highlights.length ? 'unavailable' : search.truncated || search.clips.some(c => c.vod_offset === null) ? 'partial' : 'ready', highlights, dataSource: 'existing-clips', confidence: highlights.length ? 'metadata-only' : 'unavailable', confidenceExplanation: 'Twitch Get Clips provides exact start offsets and actual durations. Scores reflect public metadata, not direct content analysis or a probability that a moment is entertaining.', warnings, analyzedAt: new Date().toISOString(), scan: { pages: search.pages, scanned: search.scanned, matched: search.clips.length, missingOffsets: search.clips.filter(c => c.vod_offset === null).length, truncated: search.truncated, dateFiltered: search.dateFiltered } };
  }
}
