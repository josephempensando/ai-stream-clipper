import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createApp } from '../src/server/app.js';
import { config } from '../src/server/config.js';
import { readFile } from 'node:fs/promises';
import { ffmpeg } from '../src/server/media.js';
import { storySettingsSchema } from '../src/shared/story.js';
const services = await createApp(path.resolve('test-artifacts/story-ui-data'));
const server = services.app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r)); const address = server.address();
if (address && typeof address === 'object') config.port = address.port;
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const browser = await chromium.launch({ headless: true, ...(existsSync(edge) ? { executablePath: edge } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.on('pageerror', e => console.error('PAGE ERROR', e.message));
  page.on('console', m => { if (m.type() === 'error') console.error('BROWSER ERROR', m.text()); });
  await page.route('**/api/story-videos/voices', route => route.fulfill({ json: { piper: true, whisper: true, ffmpeg: true, ffprobe: true, defaultVoiceId: 'en_US-lessac-medium', maxScriptCharacters: 30000, voices: [{ id: 'en_US-lessac-medium', label: 'Woman · Lessac', language: 'en', installed: true, licenseUrl: 'https://example.com/license' }, { id: 'voice-b', label: 'Man · Ryan', language: 'en', installed: true, licenseUrl: 'https://example.com/license' }, { id: 'en_US-lessac-childlike', label: 'Childlike · synthetic style', language: 'en', installed: true, licenseUrl: 'https://example.com/license' }] } }));
  const wav = path.resolve('test-artifacts/story-ui-preview.wav'); await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', '-c:a', 'pcm_s16le', wav]);
  const audio = await readFile(wav); let finishFirst!: () => Promise<void>; let firstSeen!: () => void; const seen = new Promise<void>(r => { firstSeen = r; }); const deleted: string[] = [];
  const a = '00000000-0000-4000-8000-000000000001'; const b = '00000000-0000-4000-8000-000000000002';
  await page.route('**/api/story-videos/voice-previews**', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (request.method() === 'DELETE') { deleted.push(url.pathname); await route.fulfill({ status: 204 }); return; }
    if (url.pathname.endsWith('/audio')) { await route.fulfill({ contentType: 'audio/wav', body: audio }); return; }
    if (request.method() === 'POST') {
      const body = request.postDataJSON(); const id = body.voiceId === 'voice-b' ? b : a;
      const json = { id, status: 'complete', expiresAt: new Date(Date.now() + 900000).toISOString(), error: null, actualDuration: 0.5, audioUrl: `/api/story-videos/voice-previews/${id}/audio` };
      if (id === a) { finishFirst = () => route.fulfill({ json }); firstSeen(); return; }
      assert.equal(body.speed, 1.5); await route.fulfill({ json }); return;
    }
    throw new Error('Unexpected preview request');
  });
  await page.goto(`http://127.0.0.1:${typeof address === 'object' ? address!.port : 0}`);
  await page.getByRole('button', { name: 'Story Narrator', exact: true }).click({ timeout: 5000 }).catch(async error => { console.error(await page.locator('body').innerText()); throw error; });
  await page.getByLabel('Story / script', { exact: true }).fill('One small story.');
  const voices=page.getByLabel('Narration voice',{exact:true});
  assert.deepEqual(await voices.locator('option').allTextContents(),['Woman · Lessac','Man · Ryan','Childlike · synthetic style']);
  await voices.selectOption('en_US-lessac-childlike');assert.equal(await voices.inputValue(),'en_US-lessac-childlike');
  await voices.selectOption('en_US-lessac-medium');
  assert.match(await page.getByRole('region', { name: 'Story Narrator editor' }).innerText(), /3 words/);
  assert.equal(await page.getByRole('button', { name: 'Generate Video', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Preview voice', exact: true }).click(); await seen;
  await page.getByLabel('Narration voice', { exact: true }).selectOption('voice-b'); await page.getByLabel('Speaking speed', { exact: true }).fill('1.5');
  await page.getByRole('button', { name: 'Preview voice', exact: true }).click();
  await page.locator('audio').waitFor(); assert.match((await page.locator('audio').getAttribute('src'))!, new RegExp(b));
  await page.waitForFunction(() => { const el = document.querySelector('audio'); return !!el && el.readyState >= 1 && el.duration > 0; });
  await finishFirst(); await page.waitForTimeout(150); assert.match((await page.locator('audio').getAttribute('src'))!, new RegExp(b)); assert.ok(deleted.some(url => url.endsWith(a)));
  let submitted: Record<string, unknown> | undefined;
  const jobId = '00000000-0000-4000-8000-000000000003';
  const original = 'One small story.\n\nExactly as supplied!'; await page.getByLabel('Story / script', { exact: true }).fill(original);
  await page.route('**/api/story-videos', async route => {
    if (route.request().method() === 'GET') { await route.fulfill({ json: [] }); return; }
    const multipart = route.request().postDataBuffer()!.toString('utf8'); const match = /name="settings"\r\n\r\n([^\r]+)\r\n/.exec(multipart); assert.ok(match); submitted = JSON.parse(match[1]!);
    await route.fulfill({ status: 202, json: { id: jobId, settings: submitted, backgroundName: 'sample.mp4', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), attemptId: a, status: 'queued', progress: { stage: 'Queued', percent: 0, completed: 0, total: 1 }, warnings: [], error: null } });
  });
  await page.route(`**/api/story-videos/${jobId}`, route => route.fulfill({ json: { id: jobId, settings: storySettingsSchema.parse(submitted), backgroundName: 'sample.mp4', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), attemptId: a, successfulAttemptId: a, status: 'complete', actualDuration: 3.25, progress: { stage: 'Video ready', percent: 100, completed: 1, total: 1 }, warnings: [], error: null, previewUrl: '/video-fixture.mp4', downloadUrl: '/download-fixture.mp4' } }));
  await page.getByLabel('Background MP4', { exact: true }).setInputFiles({ name: 'sample.mp4', mimeType: 'video/mp4', buffer: Buffer.from('controlled upload fixture') });
  assert.equal(await page.getByRole('button', { name: 'Generate Video', exact: true }).isDisabled(), true);
  await page.getByLabel('I have permission to use this footage.', { exact: true }).check();
  await page.getByRole('button', { name: 'Generate Video', exact: true }).click();
  await page.getByRole('link', { name: 'Download MP4', exact: true }).waitFor(); assert.equal(submitted?.script, original); assert.equal(submitted?.speed, 1.5); assert.equal('clipMinDuration' in submitted!, false);
  assert.match(await page.getByRole('region', { name: 'Story Narrator editor' }).innerText(), /3.25 seconds/);
  for (const width of [1440, 390]) { await page.setViewportSize({ width, height: 1000 }); assert.ok(await page.locator('body').evaluate(el => el.scrollWidth <= window.innerWidth + 1)); }
  await page.screenshot({ path: 'test-artifacts/story-mobile.png', fullPage: true });
  await page.route('**/api/story-videos', route => route.fulfill({ json: [{ id: jobId, title: 'Saved voice B story', createdAt: new Date().toISOString(), status: 'complete', hasOutput: true }] }));
  let finishReadiness!: () => Promise<void>;
  await page.route('**/api/story-videos/voices', route => { finishReadiness = () => route.fulfill({ json: { piper: true, whisper: true, ffmpeg: true, ffprobe: true, defaultVoiceId: 'en_US-lessac-medium', maxScriptCharacters: 30000, voices: [{ id: 'en_US-lessac-medium', label: 'Lessac', language: 'en', installed: true, licenseUrl: 'https://example.com/license' }, { id: 'voice-b', label: 'Voice B', language: 'en', installed: true, licenseUrl: 'https://example.com/license' }] } }); });
  await page.reload(); await page.getByRole('button', { name: 'Story Narrator', exact: true }).click();
  await page.getByLabel('Saved stories', { exact: true }).selectOption(jobId); await page.getByLabel('Story / script', { exact: true }).filter({ visible: true }).waitFor();
  await page.waitForFunction(() => (document.querySelector('textarea[aria-label="Story / script"]') as HTMLTextAreaElement)?.value.includes('Exactly as supplied'));
  await finishReadiness(); await page.waitForTimeout(100); assert.equal(await page.getByLabel('Narration voice', { exact: true }).inputValue(), 'voice-b');
  console.log('Story UI checks passed.');
} finally { await browser.close(); await services.story.close(); await new Promise<void>(r => server.close(() => r())); }
