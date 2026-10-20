import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { createApp } from '../src/server/app.js';
import { config } from '../src/server/config.js';
const { app, oauth, twitchLive } = await createApp(path.resolve('test-artifacts/duration-browser-data'));
const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing local address.');
config.port = address.port;
try {
  for (const script of ['scripts/check-analyzer-ui.ts', 'scripts/check-twitch-ui.ts']) {
    const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', script, `http://127.0.0.1:${address.port}`], { timeout: 120000 });
    console.log(result.stdout);
  }
} finally { oauth.close(); twitchLive.close(); server.closeAllConnections(); server.close(); }
