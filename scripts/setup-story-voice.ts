import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { storyConfig } from '../src/server/story/config.js';
import { loadVoiceCatalog } from '../src/server/story/voices.js';
await mkdir(storyConfig.voicesDir, { recursive: true });
const registry = path.join(storyConfig.voicesDir, 'voices.json');
const existing = await loadVoiceCatalog(storyConfig.voicesDir);
const presets = JSON.parse(await readFile('assets/story/voices.example.json', 'utf8')) as { voices: { id: string; label: string }[] };
let current: typeof presets = { voices: [] };
if (existing.length) current = JSON.parse(await readFile(registry, 'utf8')) as typeof presets;
for (const preset of presets.voices) {
  const entry = current.voices.find(voice => voice.id === preset.id);
  if (!entry) current.voices.push(preset);
  else if (entry.id === 'en_US-lessac-medium' && entry.label === 'Lessac · English (US)') entry.label = preset.label;
}
await writeFile(registry + '.tmp', JSON.stringify(current, null, 2) + '\n');
await rename(registry + '.tmp', registry);
const voices = await loadVoiceCatalog(storyConfig.voicesDir);
if (!voices.some(v => v.id === 'en_US-lessac-medium' && v.installed)) throw new Error('Download en_US-lessac-medium.onnx and its adjacent .onnx.json before continuing.');
for (const voice of voices) console.log(`${voice.label}: ${voice.installed ? 'ready' : 'model not installed'}`);
console.log('Review each stock voice model card and permitted uses before publishing.');
