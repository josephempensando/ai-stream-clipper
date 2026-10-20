import test from 'node:test';
import assert from 'node:assert/strict';
import { runProcess, shutdownOwnedProcesses } from '../src/server/process.js';
test('server shutdown terminates owned processes and prevents queued engines from starting', async () => {
  let ready!: () => void; const started = new Promise<void>(r => { ready = r; }); let pid = 0;
  const running = runProcess(process.execPath, ['-e', 'console.error(process.pid);setInterval(()=>{},1000)'], { onLine: line => { pid = Number(line); ready(); } });
  const failure = assert.rejects(running, /shutting down/i); await started; await shutdownOwnedProcesses(); await failure;
  assert.throws(() => process.kill(pid, 0)); await assert.rejects(runProcess(process.execPath, ['-e', 'process.exit(0)']), /shutting down/i);
});
