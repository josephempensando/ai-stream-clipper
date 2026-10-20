import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Segment } from '../../shared/types.js';
import type { CaptionStyle, RetentionEdl } from '../../shared/retention.js';
import { createAss, createRetentionSrt } from '../retention-captions.js';
export async function writeStoryCaptions(segments: Segment[], duration: number, style: CaptionStyle, directory: string) {
  const edl: RetentionEdl = { version: 1, sourceStart: 0, sourceEnd: duration, duration, keep: [{ start: 0, end: duration }], actions: [], recommendations: [] };
  const assFile = path.join(directory, 'captions.ass'); const srtFile = path.join(directory, 'captions.srt');
  await writeFile(assFile, createAss(segments, edl, style, [])); await writeFile(srtFile, createRetentionSrt(segments, edl, style, []));
  return { assFile, srtFile };
}
