import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, stat, symlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StoryStore, resolveStoryArtifact } from '../src/server/story/store.js';
import { resolveStoryInputs } from '../src/server/story/paths.js';
import type { StoryRecord } from '../src/server/story/store.js';
import { storySettingsSchema } from '../src/shared/story.js';

test('story store rejects path escapes and preserves successful drafts through failed attempt cleanup', async () => {
  const root = await mkdtemp(path.resolve('test-artifacts/story-store-')); const store = new StoryStore(root); await store.init();
  const id = randomUUID(); const attempt = randomUUID(); const success = randomUUID();
  const job: StoryRecord = { id, createdAt: '', updatedAt: '', settings: storySettingsSchema.parse({ script: 'A short story.', voiceId: 'voice-a', rights: { footagePermission: true } }), backgroundName: 'owned.mp4', attemptId: attempt, status: 'rendering', progress: { stage: 'Rendering', percent: 60, completed: 0, total: 1 }, warnings: [], error: null, successfulAttemptId: success, input: { video: { filename: 'background.mp4', originalName: 'owned.mp4', hash: 'hash', duration: 5, hasAudio: false, width: 160, height: 90 } }, artifacts: { attemptId: success, narrationDuration: 3, videoDuration: 3, videoFile: 'video.mp4', manifestFile: 'results.json' } };
  await mkdir(store.attemptDir(id, success), { recursive: true }); await writeFile(path.join(store.attemptDir(id, success), 'video.mp4'), 'complete');
  await mkdir(path.join(store.attemptDir(id, attempt), 'work'), { recursive: true }); await writeFile(path.join(store.attemptDir(id, attempt), 'partial.mp4'), 'partial');
  await store.save(job); await store.cleanupAttempt(id, attempt);
  assert.equal((await stat(path.join(store.attemptDir(id, success), 'video.mp4'))).isFile(), true);
  assert.throws(() => store.dir('../escape'));
  await assert.rejects(store.artifactPath(id, 'secret.txt'));
  const restarted = new StoryStore(root); await restarted.init();
  assert.equal(restarted.get(id).status, 'error'); assert.equal(restarted.get(id).successfulAttemptId, success);
  assert.match(restarted.get(id).error?.message || '', /interrupt|restart/i);
  const complete = restarted.get(id); complete.status = 'complete'; complete.attemptId = success;
  await mkdir(path.join(store.attemptDir(id, success), 'work')); await writeFile(path.join(store.attemptDir(id, success), 'work', 'temporary.wav'), 'work'); await restarted.save(complete);
  const finalRestart = new StoryStore(root); await finalRestart.init(); await assert.rejects(stat(path.join(store.attemptDir(id, success), 'work')), /ENOENT/); assert.equal((await stat(path.join(store.attemptDir(id, success), 'video.mp4'))).isFile(), true);
});
test('story artifacts and retained inputs cannot resolve into a different owning job', async () => {
  const root = await mkdtemp(path.resolve('test-artifacts/story-containment-')); const store = new StoryStore(root); await store.init();
  const owner = randomUUID(); const other = randomUUID(); const attempt = randomUUID(); const foreign = store.attemptDir(other, attempt); await mkdir(foreign, { recursive: true }); await writeFile(path.join(foreign, 'video.mp4'), 'private foreign video');
  await mkdir(path.join(store.dir(owner), 'runs'), { recursive: true }); await symlink(foreign, store.attemptDir(owner, attempt), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(resolveStoryArtifact(root, owner, attempt, 'video.mp4'), /path|contain|owned/i);
  const inputs = path.join(store.dir(other), 'inputs'); await mkdir(inputs); await writeFile(path.join(inputs, 'background.mp4'), 'foreign source');
  await symlink(inputs, path.join(store.dir(owner), 'inputs'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(resolveStoryInputs(store.dir(owner), false), /path|contain|owned/i);
});
