import type { SourceRights } from './rights.js';
import type { AudioAsset, ClipRetention, RetentionAnalysis, RetentionSettings } from './retention.js';
import type { ExportDestination } from './duration.js';
export interface Word { start: number; end: number; word: string }
export interface Segment { start: number; end: number; text: string; words?: Word[] }
export interface Transcript { segments: Segment[]; language: string; model: string }
export interface Evidence { time: number; loudness: number; scene: boolean }
export interface Candidate {
  id: string; start: number; end: number; heuristicScore: number;
  evidence: string[]; transcript: string; frameTimes: number[];
  cues?: Segment[];
}
export interface Highlight extends Candidate {
  retention?: RetentionAnalysis;
  title: string; explanation: string; score: number;
  // Optional for persisted projects created before automatic duration metadata.
  startTime?: number; endTime?: number; duration?: number; description?: string;
  aiSelectedDuration?: number;
  reasonForSelection?: string; engagementScore?: number;
}
export interface MediaInfo { duration: number; width: number; height: number; hasAudio: boolean }
export interface RenderOptions { layout: 'blur' | 'crop'; cropX: number; subtitles: boolean; retention?: RetentionSettings | undefined; destination?: ExportDestination | undefined }
export interface ClipEdit { id: string; start: number; end: number; adjustments?: ClipRetention | undefined }
export interface OutputClip { id: string; start: number; end: number; title: string; file: string }
export type Status = 'uploaded' | 'queued' | 'analyzing' | 'review' | 'rendering' | 'complete' | 'error';
export interface Job {
  retentionSettings?: RetentionSettings;
  audioAssets?: AudioAsset[];
  clipEdits?: ClipEdit[];
  id: string; name: string; createdAt: string; status: Status; stage: string; progress: number;
  media: MediaInfo; mediaHash: string; source: 'upload' | 'approved-url'; vodId: string | null;
  vodOffset: number; highlights: Highlight[]; outputs: OutputClip[]; warnings: string[];
  error: string | null; renderOptions: RenderOptions | null;
  rights?: SourceRights;
  highlightPolicy?: 'short-form' | 'natural';
  durationMode?: 'auto';
  clipCount?: number | 'all';
  minEngagementScore?: number;
  selectionVersion?: 1 | 2 | 3;
}
export interface Vod {
  id: string; title: string; user_id: string; user_name: string; duration: string;
  thumbnail_url: string; url: string; created_at: string; view_count: number;
}
export interface Health {
  ffmpeg: boolean; ffprobe: boolean; whisper: boolean; ollama: boolean;
  model: string; whisperModel: string; twitch: boolean; clipAuth: boolean;
  editorDefaults?: { durationMode: 'auto'; clipCount: number | 'all'; minEngagementScore?: number; minDuration?: number };
}
export interface PublicClip {
  id: string; url: string; embed_url: string; broadcaster_id: string; broadcaster_name: string;
  creator_id: string; creator_name: string; video_id: string; game_id: string; language: string;
  title: string; view_count: number; created_at: string; thumbnail_url: string; duration: number; vod_offset: number | null;
}
export interface RankedPublicClip extends PublicClip { score: number; explanation: string }
export interface ClipDiscovery {
  vod: Vod; clips: RankedPublicClip[]; scanned: number; pages: number; matched: number; eligible: number;
  truncated: boolean; analysis: 'public-metadata'; message: string;
}
export interface ViewerStatus { configured: boolean; connected: boolean; login: string | null; userId: string | null }
export interface LiveStatus {
  broadcaster: { id: string; login: string; display_name: string }; live: boolean;
  stream: { id: string; title: string; viewer_count: number; started_at: string; game_name: string } | null;
}
export interface LiveClip {
  id: string; url: string; editUrl: string; broadcasterId: string; broadcasterName: string; creatorId: string;
  createdAt: string; status: 'pending' | 'ready' | 'failed'; title: string; duration: number;
  error: string | null;
}
export type HighlightDataSource = 'existing-clips' | 'transcript' | 'none';
export type AnalysisConfidence = 'metadata-only' | 'transcript-supported' | 'unavailable';
export interface LivestreamSource {
  platform: 'twitch' | 'youtube'; id: string; url: string; title: string; creator: string;
  duration: number | null; viewCount: number | null; thumbnailUrl: string; isLive: boolean; embedAllowed: boolean;
}
export interface TimestampHighlight {
  id: string; start: number; end: number; startTime: string; endTime: string; duration: number;
  title: string; description: string; score: number; viewCount: number | null; clipUrl: string | null;
  originalUrl: string; dataSource: HighlightDataSource; confidence: AnalysisConfidence; transcript: string | null;
}
export interface TimestampAnalysis {
  source: LivestreamSource; status: 'ready' | 'partial' | 'unavailable'; highlights: TimestampHighlight[];
  dataSource: HighlightDataSource; confidence: AnalysisConfidence; confidenceExplanation: string;
  warnings: string[]; analyzedAt: string;
  scan: { pages: number; scanned: number; matched: number; missingOffsets: number; truncated: boolean; dateFiltered: boolean } | null;
}
