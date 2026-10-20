const fs = require('fs'); const path = require('path');
const args = process.argv.slice(2); const value = flag => args[args.indexOf(flag) + 1];
const input = value('--input-file'); const output = value('--output-file'); const mode = value('--model');
fs.writeFileSync(path.join(path.dirname(output), 'observed.json'), JSON.stringify({ args, text: fs.readFileSync(input, 'utf8') }));
if (mode === 'fail') process.exit(2);
if (mode === 'slow') { fs.writeFileSync(path.join(path.dirname(output), 'pid.txt'), String(process.pid)); setInterval(() => {}, 1000); }
else if (mode === 'empty') fs.writeFileSync(output, '');
else if (mode === 'corrupt') fs.writeFileSync(output, 'not a wave file');
else if (mode !== 'missing') {
  const count = 12000; const pcm = Buffer.alloc(count * 2); for (let i=0;i<count;i++) pcm.writeInt16LE(Math.round(Math.sin(i * Math.PI * 2 * 440 / 48000) * 1000), i * 2);
  const header = Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ',8); header.writeUInt32LE(16,16); header.writeUInt16LE(1,20); header.writeUInt16LE(1,22); header.writeUInt32LE(48000,24); header.writeUInt32LE(96000,28); header.writeUInt16LE(2,32); header.writeUInt16LE(16,34); header.write('data',36); header.writeUInt32LE(pcm.length,40); fs.writeFileSync(output, Buffer.concat([header,pcm]));
}
