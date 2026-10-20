import test from 'node:test';
import assert from 'node:assert/strict';
import { splitStory } from '../src/server/story/chunks.js';

test('story chunks preserve source spans, paragraphs and every Unicode word', () => {
  assert.deepEqual(splitStory('One.\n\nTwo.', 800).map(c => c.text), ['One.', 'Two.']);
  const script = '“Again, again!” ' + 'hello world '.repeat(100) + '\n\nThe end.';
  const chunks = splitStory(script, 200);
  assert.ok(chunks.every(c => c.text.length <= 200 && script.slice(c.startOffset, c.endOffset) === c.text));
  assert.equal(chunks.map(c => c.text).join(' ').replace(/\s+/g, ' ').trim(), script.replace(/\s+/g, ' ').trim());
  assert.ok(chunks.some(c => c.paragraphEnd));
  assert.throws(() => splitStory('a'.repeat(201), 200), /word|token/i);
});
