import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StoryStore } from '../src/server/story/store.js';
import { StoryJobManager } from '../src/server/story/jobs.js';
import { storySettingsSchema } from '../src/shared/story.js';
test('queued cancellation never starts engines and failed regeneration retains a successful draft', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'story-jobs-')); const store = new StoryStore(root); await store.init();
  const calls: string[] = []; let release!: () => void;
  const barrier = new Promise<void>(r => { release = r; });
  const manager = new StoryJobManager(store, async (record, directory, signal) => {
    calls.push(record.id); await barrier; signal.throwIfAborted(); throw new Error('fixture TTS failure');
  });
  const settings = storySettingsSchema.parse({ script: 'A short exact story.', voiceId: 'fixture', rights: { footagePermission: true } });
  const create = async () => { const file = path.join(root, Math.random() + '.mp4'); await writeFile(file, 'fixture'); return manager.create({ video: { file, originalName: 'background.mp4', hash: 'fixture', duration: 5, hasAudio: false } }, settings); };
  try {
    const first = await create(); const second = await create(); await manager.cancel(second.id); release(); await manager.idle();
    assert.deepEqual(calls, [first.id]); assert.equal(manager.get(second.id).status, 'cancelled'); assert.equal(manager.get(first.id).error?.code, 'STORY_FAILED');
    const results = await Promise.allSettled([manager.regenerate(first.id, settings), manager.regenerate(first.id, settings)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); await manager.idle();
  } finally { release(); await manager.close(); await rm(root, { recursive: true, force: true }); }
});
test('failed regeneration preserves the committed MP4; list summaries omit the script', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'story-draft-')); const store = new StoryStore(root); await store.init(); let calls = 0;
  const manager = new StoryJobManager(store, async (record, directory) => {
    if (calls++) throw new Error('TTS fixture failure');
    const output = path.dirname(directory); await writeFile(path.join(output, 'video.mp4'), 'successful draft'); await writeFile(path.join(output, 'results.json'), '{}');
    return { attemptId: record.attemptId, narrationDuration: 3, videoDuration: 3, videoFile: 'video.mp4', manifestFile: 'results.json' };
  });
  try {
    const file = path.join(root, 'input.mp4'); await writeFile(file, 'fixture'); const settings = storySettingsSchema.parse({ script: 'A private story.', voiceId: 'fixture', rights: { footagePermission: true } });
    const created = await manager.create({ video: { file, originalName: 'bg.mp4', hash: 'test', duration: 1, hasAudio: false } }, settings); await manager.idle();
    const success = manager.get(created.id).successfulAttemptId; assert.ok(success); await manager.cancel(created.id); assert.equal(manager.get(created.id).status, 'complete');
    await manager.regenerate(created.id, settings); await manager.idle(); assert.equal(manager.get(created.id).status, 'error'); assert.equal(manager.get(created.id).successfulAttemptId, success);
    assert.equal(await readFile(await store.artifactPath(created.id, 'video.mp4'), 'utf8'), 'successful draft'); assert.equal('settings' in manager.list()[0]!, false);
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }); }
});
test('shutdown waits for an admission already persisting and never starts its engine', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'story-shutdown-')); const store = new StoryStore(root); await store.init();
  const save = store.save.bind(store); let release!: () => void; let entered!: () => void; const enteredSave = new Promise<void>(r => { entered = r; }); const gate = new Promise<void>(r => { release = r; }); let first = true;
  store.save = async record => { if (first) { first = false; entered(); await gate; } await save(record); };
  let calls = 0; const manager = new StoryJobManager(store, async () => { calls++; throw new Error('must not start'); });
  const file = path.join(root, 'input.mp4'); await writeFile(file, 'fixture');
  const admission = manager.create({ video: { file, originalName: 'bg.mp4', hash: 'test', duration: 1, hasAudio: false } }, storySettingsSchema.parse({ script: 'A story.', voiceId: 'fixture', rights: { footagePermission: true } }));
  try {
    await enteredSave; let stopped = false; const stopping = manager.close().then(() => { stopped = true; }); await new Promise(r => setTimeout(r, 20)); assert.equal(stopped, false);
    release(); await admission; await stopping; assert.equal(calls, 0); assert.equal(store.list()[0]!.status, 'cancelled');
  } finally { release(); await admission; await manager.close(); await manager.idle(); await rm(root, { recursive: true, force: true }); }
});
test('cancelled retention rolls back moved files and never admits a hidden job', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'story-abort-admit-')); const store = new StoryStore(root); await store.init();
  const manager = new StoryJobManager(store, async () => { throw new Error('must not start'); }); const controller = new AbortController();
  const createAttempt = store.createAttempt.bind(store); store.createAttempt = async record => { controller.abort(); return createAttempt(record); };
  try {
    const file = path.join(root, 'source.mp4'); await writeFile(file, 'fixture');
    await assert.rejects(manager.create({ video: { file, originalName: 'bg.mp4', hash: 'test', duration: 1, hasAudio: false } }, storySettingsSchema.parse({ script: 'Exact text.', voiceId: 'test', rights: { footagePermission: true } }), controller.signal), /abort/i);
    await manager.idle(); assert.equal(store.list().length, 0);
    const { readdir } = await import('node:fs/promises'); assert.deepEqual(await readdir(store.base), []);
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }); }
});
