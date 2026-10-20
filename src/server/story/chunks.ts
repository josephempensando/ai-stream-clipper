export interface StoryChunk { index: number; text: string; startOffset: number; endOffset: number; paragraphEnd: boolean }
export function splitStory(script: string, maxCharacters: number): StoryChunk[] {
  if (!Number.isInteger(maxCharacters) || maxCharacters < 20) throw new Error('Invalid chunk size.');
  const chunks: StoryChunk[] = [];
  // Offsets always refer to the supplied script; whitespace is never invented as speech.
  for (const paragraph of script.matchAll(/[^\r\n]+(?:\r?\n(?!\s*\r?\n)[^\r\n]+)*/g)) {
    const source = paragraph[0]; let cursor = 0;
    while (cursor < source.length) {
      while (/\s/.test(source[cursor] || '') && cursor < source.length) cursor++;
      if (cursor >= source.length) break;
      let end = Math.min(source.length, cursor + maxCharacters);
      if (end < source.length) {
        const slice = source.slice(cursor, end);
        const sentences = [...slice.matchAll(/[.!?。！？][”’"']?\s+/g)];
        const sentence = sentences.at(-1);
        const boundary = sentence ? sentence.index + sentence[0].trimEnd().length : slice.search(/\s+\S*$/);
        if (boundary <= 0) throw new Error('A word/token exceeds the narration chunk size. Add a word boundary.');
        end = cursor + boundary;
      }
      while (end > cursor && /\s/.test(source[end - 1]!)) end--;
      const startOffset = paragraph.index + cursor;
      chunks.push({ index: chunks.length, text: source.slice(cursor, end), startOffset, endOffset: paragraph.index + end, paragraphEnd: false });
      cursor = end;
    }
    if (chunks.length) chunks.at(-1)!.paragraphEnd = true;
  }
  return chunks;
}
