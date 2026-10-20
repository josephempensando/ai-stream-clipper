import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import multer from 'multer';
import { request } from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStoryUpload } from '../src/server/story/uploads.js';
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
test('multipart music limit is enforced while streaming; disconnected uploads leave no partial files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'story-upload-')); const app = express();
  app.post('/upload', createStoryUpload(root, 16), (_req, res) => { res.sendStatus(204); });
  app.use(((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error instanceof multer.MulterError ? 413 : 400).json({ error: 'invalid' }); }) as express.ErrorRequestHandler);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r)); const address = server.address(); const port = typeof address === 'object' ? address!.port : 0;
  try {
    const form = new FormData(); form.append('music', new Blob(['x'.repeat(32)]), 'music.wav');
    assert.equal((await fetch(`http://127.0.0.1:${port}/upload`, { method: 'POST', body: form })).status, 413);
    const partial = request({ hostname: '127.0.0.1', port, path: '/upload', method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=story-boundary' } }); partial.on('error', () => {});
    partial.write('--story-boundary\r\nContent-Disposition: form-data; name="music"; filename="music.wav"\r\nContent-Type: audio/wav\r\n\r\nhello');
    await delay(80); partial.destroy();
    for (let i = 0; i < 50; i++) { if (!(await readdir(path.join(root, 'story-uploads'))).length) break; await delay(20); }
    assert.deepEqual(await readdir(path.join(root, 'story-uploads')), []);
  } finally { await new Promise<void>(r => server.close(() => r())); await rm(root, { recursive: true, force: true }); }
});
