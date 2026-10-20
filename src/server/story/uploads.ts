import multer from 'multer';
import type { Request, RequestHandler } from 'express';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';
import { StoryRequestError } from '../../shared/story.js';
import { safePath } from './paths.js';
const contexts = new WeakMap<Request, { controller: AbortController; operation: Promise<unknown> }>();
export function withStoryUpload<T>(request: Request, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const context = contexts.get(request); if (!context) throw new Error('Story upload context is missing.');
  const task = operation(context.controller.signal); context.operation = task.catch(() => {}); return task;
}
export function createStoryUpload(root: string, musicLimit = 100 * 1024 ** 2): RequestHandler {
  return async (req, res, next) => {
    const directory = safePath(path.resolve(root, 'story-uploads'), randomUUID());
    const writers: Promise<void>[] = []; const streams = new Set<Transform>();
    const context = { controller: new AbortController(), operation: Promise.resolve() as Promise<unknown> }; contexts.set(req, context);
    let aborted = false;
    const cleanup = async () => { await Promise.allSettled(writers); await context.operation; await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); req.removeListener('aborted', abort); };
    const abort = () => { aborted = true; context.controller.abort(); for (const stream of streams) stream.destroy(new Error('Upload interrupted.')); void cleanup().catch(() => {}); };
    req.once('aborted', abort);
    res.once('close', () => { if (!res.writableFinished) abort(); else void cleanup().catch(() => {}); });
    try { await mkdir(directory, { recursive: true }); }
    catch (error) { next(error); return; }
    const storage: multer.StorageEngine = {
      _handleFile(_request, file, callback) {
        const filename = file.fieldname === 'background' ? 'background.mp4' : 'music.bin'; const destination = path.join(directory, filename); let size = 0;
        const counter = new Transform({ transform(chunk: Buffer, _encoding, cb) { size += chunk.length; if (size > (file.fieldname === 'music' ? musicLimit : config.maxBytes)) cb(new multer.MulterError('LIMIT_FILE_SIZE', file.fieldname)); else cb(null, chunk); } });
        streams.add(counter); if (aborted) counter.destroy(new Error('Upload interrupted.'));
        const task = pipeline(file.stream, counter, createWriteStream(destination, { flags: 'wx' })).then(() => { callback(null, { destination: directory, filename, path: destination, size }); }, error => { callback(error as Error); }).finally(() => { streams.delete(counter); });
        writers.push(task);
      },
      _removeFile(_request, file, callback) { rm(file.path, { force: true }).then(() => callback(null), callback); },
    };
    const upload = multer({ storage, limits: { fileSize: config.maxBytes, files: 2, fields: 1, parts: 3, fieldSize: 128 * 1024 }, fileFilter: (_request, file, cb) => {
      if (file.fieldname === 'background' && !/\.mp4$/i.test(file.originalname)) cb(new StoryRequestError('INVALID_VIDEO', 'Choose an MP4 background video.'));
      else if (file.fieldname === 'music' && !/\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(file.originalname)) cb(new StoryRequestError('INVALID_MUSIC', 'Choose an audio file (MP3, WAV, M4A, AAC, OGG or FLAC).'));
      else cb(null, true);
    } }).fields([{ name: 'background', maxCount: 1 }, { name: 'music', maxCount: 1 }]);
    upload(req, res, error => { if (error || aborted) { void cleanup().then(() => { if (!aborted) next(error); }, next); } else next(); });
  };
}
