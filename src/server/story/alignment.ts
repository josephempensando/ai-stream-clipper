import path from 'node:path';
import type { Word, Segment } from '../../shared/types.js';
import type { StorySettings } from '../../shared/story.js';
import { StoryRequestError } from '../../shared/story.js';
import { transcribeChunk } from '../models.js';
import type { NarrationResult } from './piper.js';
import { forceAlignNarrationChunk } from './forced-alignment.js';
const small = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
function numberWords(n: number): string {
  if (n < 20) return small[n]!;
  if (n < 100) return ['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'][Math.floor(n / 10)]! + (n % 10 ? ' ' + small[n % 10] : '');
  if (n < 1000) return small[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' ' + numberWords(n % 100) : '');
  return numberWords(Math.floor(n / 1000)) + ' thousand' + (n % 1000 ? ' ' + numberWords(n % 1000) : '');
}
const contractions: Record<string, string> = { "don't": 'do not', "doesn't": 'does not', "didn't": 'did not', "can't": 'cannot', "won't": 'will not', "isn't": 'is not', "wasn't": 'was not', "aren't": 'are not', "weren't": 'were not', "i'm": 'i am', "it's": 'it is', "that's": 'that is', "i've": 'i have', "we're": 'we are', "you're": 'you are', "they're": 'they are', "i'll": 'i will', "we'll": 'we will', "there's": 'there is', "couldn't": 'could not', "wouldn't": 'would not', "shouldn't": 'should not' };
Object.assign(contractions, { "you'll": 'you will', "he'll": 'he will', "she'll": 'she will', "it'll": 'it will', "they'll": 'they will', "you've": 'you have', "we've": 'we have', "they've": 'they have', "haven't": 'have not', "hasn't": 'has not', "hadn't": 'had not', "mustn't": 'must not', "he's": 'he is', "she's": 'she is', "who's": 'who is', "what's": 'what is' });
function normalizeClock(text: string): string {
  const clock = (original: string, hour: string, minute: string, period: string) => Number(hour) >= 1 && Number(hour) <= 12 && Number(minute) < 60 ? `clock${Number(hour)}h${Number(minute)}m${period}m` : original;
  return text.replace(/\b(\d{1,2})\s*[:.]\s*(\d{2})\s*([ap])\.?m\b\.?/g, clock)
    .replace(/\b(\d{3,4})\s*([ap])\.?m\b\.?/g, (original, digits: string, period: string) => clock(original, digits.slice(0, -2), digits.slice(-2), period));
}
export function storyRecognitionHints(script: string): string | undefined {
  const names = new Set<string>();
  for (const match of script.matchAll(/\b(?:Mr|Mrs|Ms|Dr)\.\s+([\p{Lu}][\p{L}'’-]+)/gu)) names.add(match[1]!);
  for (const match of script.matchAll(/\b[\p{Lu}][\p{L}'’-]{2,}/gu)) {
    const prefix = script.slice(0, match.index).trimEnd();
    if (/[\p{Ll}]$/u.test(prefix) && /[\p{Ll}]/u.test(match[0]) && !['Mr', 'Mrs', 'Ms', 'Dr'].includes(match[0])) names.add(match[0]);
  }
  // Vocabulary from the source biases spelling without prompting a continuation
  // of the story, which can make Whisper repeat/hallucinate whole passages.
  const hints: string[] = [];
  for (const name of names) { if ([...hints, name].join(', ').length > 160) break; hints.push(name); }
  return hints.length ? hints.join(', ') + '.' : undefined;
}
function normalize(text: string): string {
  return normalizeClock(text.normalize('NFKC').toLowerCase().replace(/[’‘]/g, "'")).replace(/\b\d{1,4}\b/g, v => numberWords(Number(v))).replace(/[\p{L}]+(?:'[\p{L}]+)?/gu, v => contractions[v] || v).replace(/[^\p{L}\p{N}]/gu, '');
}
function failure(message: string): never { throw new StoryRequestError('CAPTION_ALIGNMENT_REVIEW_REQUIRED', `Caption alignment needs review: ${message} Retry narration or disable subtitles.`, 422); }
export function alignScript(script: string, recognized: Word[], duration: number): { segments: Segment[]; coverage: number; warnings: string[] } {
  let previous = 0;
  for (const word of recognized) {
    if (![word.start, word.end].every(Number.isFinite) || word.start < previous - 0.001 || word.end <= word.start || word.end > duration + 0.001 || !normalize(word.word)) failure('invalid word timestamps.');
    previous = word.end;
  }
  const tokens = [...script.matchAll(/\S+/gu)].map(m => m[0]);
  // Attach punctuation-only tokens to their preceding original token.
  const source: string[] = [];
  for (const token of tokens) { if (!normalize(token) && source.length) source[source.length - 1] += ' ' + token; else source.push(token); }
  const memo = new Map<string, { cost: number; words: Word[] } | null>();
  let furthestSource = 0;
  function solve(i: number, j: number): { cost: number; words: Word[] } | null {
    furthestSource = Math.max(furthestSource, i);
    if (i === source.length) return { cost: recognized.length - j, words: [] };
    if (j === recognized.length) return null;
    const key = `${i}:${j}`; if (memo.has(key)) return memo.get(key)!;
    let best: { cost: number; words: Word[] } | null = null;
    for (let a = 1; a <= 3 && i + a <= source.length; a++) for (let b = 1; b <= 5 && j + b <= recognized.length; b++) {
      if (normalize(source.slice(i, i + a).join(' ')) !== normalize(recognized.slice(j, j + b).map(w => w.word).join(' '))) continue;
      const next = solve(i + a, j + b); if (!next) continue;
      const candidate = { cost: next.cost + (a + b - 2) * 0.01, words: [{ word: source.slice(i, i + a).join(' '), start: recognized[j]!.start, end: recognized[j + b - 1]!.end }, ...next.words] };
      if (!best || candidate.cost < best.cost) best = candidate;
    }
    const skipped = solve(i, j + 1);
    if (skipped && (!best || skipped.cost + 1 < best.cost)) best = { ...skipped, cost: skipped.cost + 1 };
    memo.set(key, best); return best;
  }
  const result = solve(0, 0); if (!result || !result.words.length) failure(`the spoken words do not cover the supplied script near “${(source[furthestSource] || '').slice(0, 60)}”.`);
  const segments: Segment[] = []; let words: Word[] = [];
  const flush = () => { if (words.length) segments.push({ start: words[0]!.start, end: words.at(-1)!.end, text: words.map(w => w.word).join(' '), words }); words = []; };
  for (const word of result.words) { words.push(word); if (words.length >= 12 || /[.!?。！？][”’"']?$/.test(word.word)) flush(); } flush();
  return { segments, coverage: 1, warnings: result.cost >= 1 ? ['Extra recognized words were excluded; captions retain only the supplied script.'] : [] };
}
export async function alignNarration(narration: NarrationResult, settings: StorySettings, workDir: string, signal: AbortSignal, onProgress: (completed: number, total: number) => Promise<void>, language = 'en', forceAlign = forceAlignNarrationChunk) {
  if (!settings.subtitles.enabled) return { segments: [], coverage: 1, warnings: [] as string[] };
  const segments: Segment[] = []; const warnings: string[] = [];
  for (const chunk of narration.chunks) {
    let aligned: ReturnType<typeof alignScript> | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      signal.throwIfAborted();
      const hints = attempt ? storyRecognitionHints(chunk.text) : undefined;
      const recognized = await transcribeChunk(chunk.wavFile, path.join(workDir, `alignment-${chunk.index}-${attempt}`), { signal, language, independentWindows: true, ...(hints ? { initialPrompt: hints } : {}) });
      try { aligned = alignScript(chunk.text, recognized.flatMap(s => s.words || []), chunk.duration); break; }
      catch (error) {
        // The script is known because Piper just generated this narration.
        // Recognition spelling is not a word-to-audio alignment algorithm.
        try {
          const words = await forceAlign(chunk.wavFile, chunk.text, recognized.flatMap(s => s.words || []), path.join(workDir, `forced-${chunk.index}-${attempt}`), signal, language);
          aligned = alignScript(chunk.text, words, chunk.duration);
          aligned.warnings.push(`Whisper aligned the supplied narration text to the actual audio in chunk ${chunk.index + 1}; review pronunciation.`);
          break;
        } catch { signal.throwIfAborted(); }
        if (attempt) { if (error instanceof StoryRequestError) throw new StoryRequestError(error.code, `Narration chunk ${chunk.index + 1} of ${narration.chunks.length}: ${error.message}`, error.status); throw error; }
      }
    }
    for (const segment of aligned!.segments) segments.push({ ...segment, start: segment.start + chunk.offset, end: segment.end + chunk.offset, words: segment.words!.map(w => ({ ...w, start: w.start + chunk.offset, end: w.end + chunk.offset })) });
    warnings.push(...aligned!.warnings); await onProgress(chunk.index + 1, narration.chunks.length);
  }
  return { segments, coverage: 1, warnings };
}
