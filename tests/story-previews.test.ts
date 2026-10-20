import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { VoicePreviewManager } from '../src/server/story/previews.js';
import { storyConfig } from '../src/server/story/config.js';
test('voice previews return an immediate ID, bound concurrent reservations, cancel and expire privately', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'story-preview-')); const voices = path.join(root, 'voices'); await mkdir(voices);
  await writeFile(path.join(voices, 'test.onnx'), 'fixture'); await writeFile(path.join(voices, 'test.onnx.json'), JSON.stringify({ audio: { sample_rate: 22050 } }));
  await writeFile(path.join(voices, 'voices.json'), JSON.stringify({ voices: [{ id: 'test', label: 'Test', language: 'en', model: 'test.onnx', config: 'test.onnx.json', permitted: true, licenseUrl: 'https://example.com/license' }] }));
  const originalDir = storyConfig.voicesDir; const originalPython = storyConfig.python; storyConfig.voicesDir = voices; storyConfig.python = process.execPath;
  const manager = new VoicePreviewManager(root); await manager.init();
  try {
    const before = Date.now(); const requests = await Promise.allSettled(Array.from({ length: 4 }, () => manager.create('A preview.', 'test', 1)));
    assert.equal(requests.filter(r => r.status === 'fulfilled').length, 3); const rejected = requests.find(r => r.status === 'rejected'); assert.ok(rejected?.status === 'rejected' && rejected.reason.status === 429);
    for (const request of requests) if (request.status === 'fulfilled') {
      assert.ok(request.value.id); assert.equal(request.value.audioUrl, undefined); assert.ok(Date.parse(request.value.expiresAt) >= before + 900_000);
      await manager.cancelAndDelete(request.value.id); await assert.rejects(manager.audioPath(request.value.id), /expired|exist/i); await manager.cancelAndDelete(request.value.id);
    }
    const pending = manager.create('Pending admission.', 'test', 1); const closing = manager.close();
    await assert.rejects(pending, /shutting down/i); await closing;
  } finally { await manager.close(); storyConfig.voicesDir = originalDir; storyConfig.python = originalPython; await rm(root, { recursive: true, force: true }); }
});
