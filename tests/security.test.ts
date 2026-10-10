import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicAddress, validateMediaUrl } from '../src/server/security.js';
import { Semaphore } from '../src/server/process.js';
import dns from 'node:dns/promises';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { downloadApproved } from '../src/server/security.js';

test('SSRF denies loopback, private, link-local, mapped IPv6 and reserved addresses', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fc00::1', '::ffff:127.0.0.1', '100.64.0.1', '0.0.0.0', '224.0.0.1']) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress('1.1.1.1'), true);
});
test('approved media requires exact HTTPS hostname and standard port', () => {
  assert.equal(validateMediaUrl('https://media.example.test/owned.mp4', ['media.example.test']).hostname, 'media.example.test');
  for (const url of ['http://media.example.test/a', 'https://media.example.test.evil/a', 'https://user:pass@media.example.test/a', 'https://media.example.test:444/a', 'https://127.0.0.1/a']) assert.throws(() => validateMediaUrl(url, ['media.example.test', '127.0.0.1']));
});
test('FFmpeg semaphore limits concurrent work and releases capacity after errors', async () => {
  const queue = new Semaphore(2); let active = 0; let max = 0;
  await Promise.all(Array.from({ length: 8 }, () => queue.run(async () => {
    active++; max = Math.max(max, active); await new Promise(resolve => setTimeout(resolve, 10)); active--;
  })));
  assert.equal(max, 2);
  await assert.rejects(queue.run(async () => { throw new Error('expected'); }));
  assert.equal(await queue.run(async () => 42), 42);
});
test('rejected redirect bodies are destroyed rather than drained without size bounds', async t => {
  t.mock.method(dns, 'lookup', async () => [{ address: '1.1.1.1', family: 4 }]);
  const response = Object.assign(new PassThrough(), { statusCode: 302, headers: {} }); let destroyedRequest = false;
  t.mock.method(https, 'get', (...args: unknown[]) => {
    const request = Object.assign(new EventEmitter(), { setTimeout: () => request, destroy: () => { destroyedRequest = true; request.emit('close'); return request; } });
    const callback = args[2] as (message: IncomingMessage) => void;
    queueMicrotask(() => callback(response as unknown as IncomingMessage)); return request;
  });
  await assert.rejects(downloadApproved('https://approved.test/media.mp4', path.resolve('test-artifacts/rejected-download.tmp'), ['approved.test'], 100), /redirects/);
  assert.equal(response.destroyed, true); assert.equal(destroyedRequest, true);
});
test('DNS resolving any approved hostname to private space is rejected before connecting', async t => {
  t.mock.method(dns, 'lookup', async () => [{ address: '1.1.1.1', family: 4 }, { address: '127.0.0.1', family: 4 }]);
  let connected = false; t.mock.method(https, 'get', () => { connected = true; throw new Error('Should not connect'); });
  await assert.rejects(downloadApproved('https://approved.test/media.mp4', path.resolve('test-artifacts/rejected-download.tmp'), ['approved.test'], 100), /non-public/);
  assert.equal(connected, false);
});
