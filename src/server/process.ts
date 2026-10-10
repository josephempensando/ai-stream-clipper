import { spawn } from 'node:child_process';

export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid concurrency');
  }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>(resolve => this.waiting.push(resolve));
    else this.active++;
    try { return await operation(); }
    finally {
      const next = this.waiting.shift();
      if (next) next(); else this.active--;
    }
  }
}
export interface ProcessOptions { timeout?: number; onLine?: (line: string) => void; cwd?: string }
export async function runProcess(executable: string, args: string[], options: ProcessOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, ...(options.cwd ? { cwd: options.cwd } : {}) });
    let output = ''; let error = ''; let pending = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${executable.split(/[\\/]/).at(-1)} timed out.`)); }, options.timeout || 3_600_000);
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); if (output.length > 4_000_000) output = output.slice(-4_000_000); });
    child.stderr.on('data', (data: Buffer) => {
      const text = data.toString(); error = (error + text).slice(-6000);
      pending += text; const lines = pending.split(/[\r\n]/); pending = lines.pop() || '';
      for (const line of lines) options.onLine?.(line);
    });
    child.on('error', () => { clearTimeout(timer); reject(new Error(`Cannot start ${executable.split(/[\\/]/).at(-1)}. Check installation and .env paths.`)); });
    child.on('close', code => {
      clearTimeout(timer); if (pending) options.onLine?.(pending);
      if (code === 0) resolve(output); else reject(new Error(`Media/model command failed (${code}): ${error.slice(-1800)}`));
    });
  });
}
