import { spawn } from 'node:child_process';
import path from 'node:path';
const ownedProcesses = new Set<{ stop: (error: Error) => void; closed: Promise<void> }>();
let shuttingDown = false;
export async function shutdownOwnedProcesses(): Promise<void> {
  shuttingDown = true;
  const entries = [...ownedProcesses]; for (const entry of entries) entry.stop(new Error('Server is shutting down.'));
  await Promise.all(entries.map(entry => entry.closed));
}

export class Semaphore {
  private active = 0;
  private readonly waiting: { start: () => void; abort?: () => void; signal?: AbortSignal }[] = [];
  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid concurrency');
  }
  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.active >= this.limit) await new Promise<void>((resolve, reject) => {
      const waiter: typeof this.waiting[number] = { start: resolve, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.abort = () => { const index = this.waiting.indexOf(waiter); if (index >= 0) this.waiting.splice(index, 1); reject(signal.reason); };
        signal.addEventListener('abort', waiter.abort, { once: true });
      }
      this.waiting.push(waiter);
      if (signal?.aborted) waiter.abort?.();
    });
    else this.active++;
    try { signal?.throwIfAborted(); return await operation(); }
    finally {
      const next = this.waiting.shift();
      if (next) { if (next.abort) next.signal?.removeEventListener('abort', next.abort); next.start(); } else this.active--;
    }
  }
}
export interface ProcessOptions { timeout?: number; onLine?: (line: string) => void; cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal }
export async function runProcess(executable: string, args: string[], options: ProcessOptions = {}): Promise<string> {
  if (shuttingDown) throw new Error('Server is shutting down.');
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, ...(options.cwd ? { cwd: options.cwd } : {}), ...(options.env ? { env: options.env } : {}) });
    let output = ''; let error = ''; let pending = '';
    let failure: Error | undefined; let settled = false; let termination = Promise.resolve();
    const stop = (error: Error) => {
      if (settled || failure) return; failure = error;
      if (process.platform === 'win32' && child.pid) {
        // Whisper can have an FFmpeg decoder child. Kill only this owned PID
        // tree and await the helper as well as the actual child's close event.
        termination = new Promise<void>(done => {
          const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
          killer.once('error', () => { child.kill(); done(); });
          killer.once('close', () => { child.kill(); done(); });
        });
      } else child.kill();
    };
    let closed!: () => void; const tracked = { stop, closed: new Promise<void>(resolve => { closed = resolve; }) }; ownedProcesses.add(tracked);
    const abort = () => stop(options.signal?.reason instanceof Error ? options.signal.reason : new DOMException('Cancelled.', 'AbortError'));
    const timer = setTimeout(() => stop(new Error(`${executable.split(/[\\/]/).at(-1)} timed out.`)), options.timeout || 3_600_000);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const cleanup = () => { settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort); ownedProcesses.delete(tracked); closed(); };
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); if (output.length > 4_000_000) output = output.slice(-4_000_000); });
    child.stderr.on('data', (data: Buffer) => {
      const text = data.toString(); error = (error + text).slice(-6000);
      pending += text; const lines = pending.split(/[\r\n]/); pending = lines.pop() || '';
      for (const line of lines) options.onLine?.(line);
    });
    child.on('error', () => { if (!settled) { cleanup(); reject(failure || new Error(`Cannot start ${executable.split(/[\\/]/).at(-1)}. Check installation and .env paths.`)); } });
    child.on('close', async code => {
      if (settled) return;
      if (options.signal?.aborted) abort();
      await termination;
      cleanup(); if (pending) options.onLine?.(pending);
      if (failure) reject(failure);
      else if (code === 0) resolve(output); else reject(new Error(`Media/model command failed (${code}): ${error.slice(-1800)}`));
    });
  });
}
