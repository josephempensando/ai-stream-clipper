import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { StoryRequestError } from '../../shared/story.js';

export function safePath(root: string, ...parts: string[]): string {
  const base = path.resolve(root); const result = path.resolve(base, ...parts);
  const relative = path.relative(base, result);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new StoryRequestError('INVALID_PATH', 'Invalid story artifact path.');
  return result;
}
export async function containedFile(root: string, relative: string): Promise<string> {
  const candidate = safePath(root, relative); const [base, actual] = await Promise.all([realpath(root), realpath(candidate)]);
  safePath(base, actual);
  if (!(await stat(actual)).isFile()) throw new StoryRequestError('INVALID_PATH', 'Expected a regular local file.');
  return actual;
}
export async function ownedDirectory(root: string, relative: string): Promise<string> {
  const candidate = safePath(root, relative); const [base, actual] = await Promise.all([realpath(root), realpath(candidate)]);
  const expected = safePath(base, relative); const compare = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  if (compare(actual) !== compare(expected) || !(await stat(actual)).isDirectory()) throw new StoryRequestError('INVALID_PATH', 'Story directory must remain within its original owning path.');
  return actual;
}
export async function resolveStoryInputs(jobDirectory: string, music: boolean): Promise<{ video: string; music?: string }> {
  const job = await ownedDirectory(path.dirname(jobDirectory), path.basename(jobDirectory));
  const directory = await ownedDirectory(job, 'inputs');
  return { video: await containedFile(directory, 'background.mp4'), ...(music ? { music: await containedFile(directory, 'music.bin') } : {}) };
}
