const { spawn } = require('node:child_process');
process.stderr.write(`${process.pid}\n`);
if (process.argv[2] === 'tree') {
  const child = spawn(process.execPath, [__filename, 'idle'], { stdio: 'ignore', windowsHide: true });
  process.stderr.write(`${child.pid}\n`);
}
setInterval(() => {}, 1000);
