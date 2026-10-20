import test from 'node:test';
import assert from 'node:assert/strict';
import { runProcess, Semaphore } from '../src/server/process.js';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

test('cancelled queued operations never launch and other waiters remain FIFO', async () => {
  const queue = new Semaphore(1); const controller = new AbortController(); const called: number[] = [];
  let release!: () => void;
  const first = queue.run(() => new Promise<void>(resolve => { release = resolve; }));
  const cancelled = queue.run(async () => { called.push(2); }, controller.signal);
  const rejected = assert.rejects(cancelled, { name: 'AbortError' });
  const third = queue.run(async () => { called.push(3); });
  controller.abort(); release(); await Promise.all([first, rejected, third]);
  assert.deepEqual(called, [3]);
});
test('aborting a real child waits for termination and abort before launch rejects', async () => {
  const controller = new AbortController(); let pid = 0;
  const work = runProcess(process.execPath, ['-e', 'process.stderr.write(String(process.pid)+"\\n");setInterval(()=>{},1000)'], { timeout: 2000, signal: controller.signal, onLine: line => { if (/^\d+$/.test(line)) { pid = Number(line); controller.abort(); } } });
  await assert.rejects(work, { name: 'AbortError' });
  assert.ok(pid > 0); assert.throws(() => process.kill(pid, 0));
  await assert.rejects(runProcess('must-never-launch', [], { signal: AbortSignal.abort() }), { name: 'AbortError' });
});
test('timeout stops the real process before rejection and normal calls are unchanged', async () => {
  let pid = 0;
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.stderr.write(String(process.pid)+"\\n");setInterval(()=>{},1000)'], { timeout: 1000, onLine: line => { if (/^\d+$/.test(line)) pid = Number(line); } }), /timed out/);
  assert.ok(pid > 0); assert.throws(() => process.kill(pid, 0));
  assert.equal(await runProcess(process.execPath, ['-e', 'process.stdout.write("ok")']), 'ok');
  await delay(5);
});
test('Windows cancellation terminates the recorded child tree', { skip: process.platform !== 'win32' }, async () => {
  const controller = new AbortController(); const pids: number[] = [];
  const work = runProcess(process.execPath, [path.resolve('tests/fixtures/story/process-child.cjs'), 'tree'], { timeout: 2500, signal: controller.signal, onLine: line => { if (/^\d+$/.test(line)) { pids.push(Number(line)); if (pids.length === 2) controller.abort(); } } });
  try { await assert.rejects(work, { name: 'AbortError' }); assert.equal(pids.length, 2); for (const pid of pids) assert.throws(() => process.kill(pid, 0)); }
  finally { for (const pid of pids) { try { process.kill(pid); } catch { /* already terminated */ } } }
});
