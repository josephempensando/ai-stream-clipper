import { z } from 'zod';

export const captionStyleSchema = z.object({
  enabled: z.boolean().default(true), font: z.enum(['Arial', 'Verdana', 'Trebuchet MS']).default('Arial'),
  size: z.number().int().min(32).max(80).default(54), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#FFFFFF'),
  highlight: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#F8CB46'), outline: z.number().min(0).max(6).default(3),
  position: z.enum(['lower', 'middle', 'upper']).default('lower'), animation: z.enum(['karaoke', 'fade', 'none']).default('karaoke'),
  wordsPerGroup: z.number().int().min(2).max(8).default(5),
});
export const retentionSettingsSchema = z.object({
  autoEdit: z.boolean().default(false), hookStrategy: z.enum(['auto', 'verbal', 'visual', 'emotional']).default('auto'),
  hookText: z.boolean().default(true), patternInterrupts: z.boolean().default(true), trimPauses: z.boolean().default(true),
  captions: captionStyleSchema.default(() => captionStyleSchema.parse({})), fps: z.union([z.literal(30), z.literal(60)]).default(30),
  normalize: z.boolean().default(true), dialogueLufs: z.number().min(-24).max(-12).default(-16),
  musicId: z.string().uuid().nullable().default(null), musicGainDb: z.number().min(-45).max(0).default(-22),
  sfxId: z.string().uuid().nullable().default(null), sfxGainDb: z.number().min(-40).max(0).default(-18),
  ending: z.enum(['natural', 'loop', 'cta']).default('natural'), cta: z.string().trim().max(100).default(''),
});
export type RetentionSettings = z.infer<typeof retentionSettingsSchema>;
export type CaptionStyle = z.infer<typeof captionStyleSchema>;
export const beatNames = ['hook', 'setup', 'escalation', 'payoff', 'ending'] as const;
export interface Beat { start: number; end: number; quote: string; first: number; last: number }
export interface Narrative {
  beats: Record<typeof beatNames[number], Beat | null>; coherent: boolean; reason: string;
  loop: boolean; loopReason: string; emphasis: number[]; pauseCuts: number[];
  firstSeconds: { start: number; end: number; quote: string }; strategy: RetentionSettings['hookStrategy'];
}
export interface KeepSpan { start: number; end: number }
export interface EdlAction { type: 'keep' | 'remove-silence' | 'punch-in' | 'hook-text' | 'cta' | 'loop' | 'normalize' | 'music' | 'sfx'; start: number; end: number; reason: string; text?: string }
export interface RetentionEdl { version: 1; sourceStart: number; sourceEnd: number; duration: number; keep: KeepSpan[]; actions: EdlAction[]; recommendations: string[] }
export interface RetentionAnalysis { narrative: Narrative; edl: RetentionEdl }
export const captionCorrectionSchema = z.object({ start: z.number().finite().nonnegative(), end: z.number().finite().positive(), text: z.string().trim().min(1).max(100) });
export const clipRetentionSchema = z.object({
  captions: z.array(captionCorrectionSchema).max(5000).default([]), patternInterrupts: z.boolean().optional(),
  ending: z.enum(['natural', 'loop', 'cta']).optional(),
});
export type ClipRetention = z.infer<typeof clipRetentionSchema>;
export interface AudioAsset { id: string; kind: 'music' | 'sfx'; name: string; provenance: string; license: 'owned' | 'licensed'; permission: true; addedAt: string }
