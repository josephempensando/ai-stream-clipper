import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ffmpeg } from '../src/server/media.js';

export async function createDemo(output: string, seconds = 300): Promise<void> {
  await mkdir(path.dirname(output), { recursive: true });
  // Entirely generated media; no third-party VOD or borrowed speech.
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-threads', '2', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', output]);
}
if (process.argv[1]?.endsWith('create-demo.ts')) {
  const output = path.resolve(process.argv[2] || 'data/demo/owned-test-recording.mp4');
  await createDemo(output); console.log(`Generated owned test recording: ${output}\nThis synthetic video has a tone, not streamer speech. Use it to validate media processing; use a spoken recording for actual highlight quality.`);
}
