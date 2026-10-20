import { z } from 'zod';
import { captionStyleSchema } from './retention.js';

export const voiceIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
export function createStorySettingsSchema(maxCharacters = 30_000) {
  return z.object({
    script: z.string().min(1).max(maxCharacters).refine(value => value.trim().length > 0 && !/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(value) && new TextEncoder().encode(value).length <= 128 * 1024, 'Enter a nonempty text script without control characters (up to 128 KiB).'),
    voiceId: voiceIdSchema, speed: z.number().finite().min(0.75).max(1.5).default(1),
    subtitles: captionStyleSchema.default(() => captionStyleSchema.parse({})),
    layout: z.enum(['blur', 'crop']).default('crop'), cropX: z.number().finite().min(0).max(1).default(0.5),
    fitMode: z.enum(['auto', 'loop', 'slow-loop']).default('auto'),
    backgroundMuted: z.boolean().default(true), backgroundGainDb: z.number().finite().min(-45).max(0).default(-22),
    musicGainDb: z.number().finite().min(-45).max(0).default(-22),
    rights: z.object({ footagePermission: z.literal(true), music: z.object({ permission: z.literal(true), license: z.enum(['owned', 'licensed']), provenance: z.string().trim().min(5).max(2000) }).strict().optional() }).strict(),
  }).strict();
}
export const storySettingsSchema = createStorySettingsSchema();
export type StorySettings = z.infer<typeof storySettingsSchema>;
export const storyStatuses = ['queued', 'synthesizing', 'aligning', 'rendering', 'cancelling', 'complete', 'cancelled', 'error'] as const;
export type StoryStatus = typeof storyStatuses[number];
export interface StoryError { code: string; message: string }
export interface StoryProgress { stage: string; percent: number; completed: number; total: number }
export interface PublicVoice { id: string; label: string; language: string; licenseUrl: string; installed: boolean }
export interface StoryReadiness { piper: boolean; whisper: boolean; ffmpeg: boolean; ffprobe: boolean; defaultVoiceId: string; voices: PublicVoice[]; maxScriptCharacters: number; setupError?: string }
export interface StoryJob {
  id: string; createdAt: string; updatedAt: string; settings: StorySettings;
  backgroundName: string; musicName?: string; attemptId: string; status: StoryStatus; progress: StoryProgress;
  actualDuration?: number; warnings: string[]; error: StoryError | null; successfulAttemptId?: string;
  previewUrl?: string; downloadUrl?: string; captionsUrl?: string;
}
export interface StorySummary { id: string; title: string; createdAt: string; status: StoryStatus; actualDuration?: number; hasOutput: boolean }
export interface VoicePreview { id: string; status: StoryStatus; expiresAt: string; actualDuration?: number; audioUrl?: string; error: StoryError | null }
export class StoryRequestError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
export function storyPreviewExcerpt(script: string): string {
  const text = script.trim(); if (text.length <= 300) return text;
  const prefix = text.slice(0, 301); const end = prefix.search(/\s+\S*$/u);
  return end > 0 ? prefix.slice(0, end).trimEnd() : '';
}
export function storyStats(script: string, speed: number): { words: number; characters: number; estimatedSeconds: number } {
  const words = [...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(script)].filter(part => part.isWordLike).length;
  return { words, characters: script.length, estimatedSeconds: Math.round(words * 60 / (150 * speed) * 1000) / 1000 };
}
