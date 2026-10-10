import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createApp } from '../src/server/app.js';
import { config } from '../src/server/config.js';
import type { ClipEdit, Job } from '../src/shared/types.js';
import { unknownRights } from '../src/shared/rights.js';

const external = process.argv[2];
const server = external ? null : (await createApp(path.resolve('test-artifacts/ui-data'))).app.listen(0, '127.0.0.1');
if (server) await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
const address = server?.address();
if (address && typeof address !== 'string') config.port = address.port;
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const browser = await chromium.launch({ headless: true, ...(existsSync(edge) ? { executablePath: edge } : {}) });
try {
  await mkdir('test-artifacts', { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  page.on('requestfailed', request => console.error('Request failed:', request.url(), request.failure()?.errorText));
  page.on('console', message => { if (message.type() === 'error') console.error('Browser:', message.text()); });
  await page.goto(external || `http://127.0.0.1:${config.port}`);
  await page.getByRole('heading', { name: 'Long streams. Short-form gold.' }).waitFor().catch(async error => {
    console.error({ errors, url: page.url() });
    await page.screenshot({ path: 'test-artifacts/dashboard-failure.png', fullPage: true });
    throw error;
  });
  await page.getByRole('button', { name: 'Analyze authorized recording', exact: true }).click();
  assert.match(await page.locator('.recipe-grid:visible').innerText(), /AI chosen/);
  assert.doesNotMatch(await page.locator('.analysis-panel:visible').innerText(), /30–60/);
  assert.equal(await page.getByLabel('Duration mode', { exact: true }).inputValue(), 'auto');
  await page.getByLabel('Number of highlights', { exact: true }).fill('7');
  assert.match(await page.locator('.recipe-grid:visible').innerText(), /Up to 7/);
  await page.getByLabel('License category', { exact: true }).selectOption('creative-commons');
  await page.getByLabel('Creative Commons license', { exact: true }).selectOption('CC BY-NC-SA 4.0');
  assert.match(await page.getByRole('region', { name: 'Source rights' }).innerText(), /NonCommercial/);
  assert.match(await page.getByRole('region', { name: 'Source rights' }).innerText(), /ShareAlike/);
  await page.getByLabel('License category', { exact: true }).selectOption('unknown');
  assert.match(await page.getByRole('region', { name: 'Source rights' }).innerText(), /Private analysis remains available/);
  assert.equal(await page.getByRole('button', { name: 'Analyze stream', exact: true }).isDisabled(), true);
  await page.screenshot({ path: 'test-artifacts/dashboard-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Twitch VOD', exact: true }).click();
  assert.equal(await page.getByLabel('Twitch VOD URL or ID', { exact: true }).inputValue(), 'https://www.twitch.tv/videos/2895693134');
  await page.getByLabel('Twitch VOD URL or ID', { exact: true }).fill('https://evil.test/videos/123');
  await page.getByRole('button', { name: 'Look up' }).click();
  await page.getByRole('alert').waitFor(); assert.match(await page.getByRole('alert').innerText(), /Twitch VOD/);
  await page.getByRole('button', { name: 'Dismiss error' }).click();
  await page.getByRole('button', { name: 'Local setup', exact: true }).click();
  await page.getByRole('heading', { name: 'Engine room' }).waitFor();
  await page.getByRole('button', { name: 'Recordings', exact: false }).click();
  await page.getByRole('heading', { name: 'Saved recordings' }).waitFor();
  await page.getByRole('button', { name: 'New project' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: 'test-artifacts/dashboard-mobile.png', fullPage: true });
  // Model-chosen durations survive the review inputs and render submission.
  const review = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const fixture: Job = { id: 'range-review', name: 'Natural ranges fixture.mp4', createdAt: new Date().toISOString(), status: 'review', stage: 'Ready for review', progress: 100, media: { duration: 500, width: 1920, height: 1080, hasAudio: true }, mediaHash: 'fixture', source: 'upload', vodId: null, vodOffset: 0, highlights: [
    { id: 'short', start: 0, end: 12, title: 'Short reaction', explanation: 'The reaction completes here.', score: 95, heuristicScore: 10, transcript: 'Setup and reaction.', evidence: [], frameTimes: [] },
    { id: 'long', start: 200, end: 390, title: 'Long story', explanation: 'The story needs its full setup and payoff.', score: 90, heuristicScore: 10, transcript: 'Complete story.', evidence: [], frameTimes: [] },
  ], outputs: [], warnings: [], error: null, renderOptions: null, durationMode: 'auto', clipCount: 2, rights: { ...unknownRights(), expiresAt: '2030-01-01T12:00:00+08:00' } };
  let submitted: ClipEdit[] | undefined;
  let analysisSettings: unknown;
  await review.route('**/api/health', route => route.fulfill({ json: { ffmpeg: true, ffprobe: true, whisper: true, ollama: true, model: 'test-double', whisperModel: 'test-double', twitch: false, clipAuth: false, editorDefaults: { durationMode: 'auto', clipCount: 5 } } }));
  await review.route('**/api/jobs', route => route.fulfill({ json: [fixture] }));
  await review.route('**/api/jobs/range-review/media', route => route.fulfill({ status: 204 }));
  await review.route('**/api/jobs/range-review/render', async route => {
    submitted = (route.request().postDataJSON() as { clips: ClipEdit[] }).clips;
    await route.fulfill({ json: fixture });
  });
  await review.route('**/api/jobs/range-review/analyze', async route => {
    analysisSettings = route.request().postDataJSON();
    await route.fulfill({ json: { ...fixture, clipCount: 7 } });
  });
  await review.goto(external || `http://127.0.0.1:${config.port}`);
  await review.getByRole('button', { name: 'Recordings', exact: false }).click();
  await review.getByRole('button', { name: /Natural ranges fixture/ }).click();
  assert.equal(await review.getByLabel('Permission expires (UTC)', { exact: true }).inputValue(), '2030-01-01T04:00');
  assert.equal(await review.getByLabel('End for Short reaction', { exact: true }).inputValue(), '12');
  assert.equal(await review.getByLabel('End for Short reaction', { exact: true }).getAttribute('min'), '0');
  assert.equal(await review.getByLabel('End for Long story', { exact: true }).inputValue(), '390');
  assert.equal(await review.getByLabel('Number of highlights', { exact: true }).inputValue(), '2');
  await review.getByLabel('Number of highlights', { exact: true }).fill('7');
  const analyzeRequest = review.waitForRequest('**/api/jobs/range-review/analyze');
  await review.getByRole('button', { name: 'Analyze again', exact: true }).click(); await analyzeRequest;
  await review.getByRole('button', { name: 'Analyze again', exact: true }).waitFor();
  assert.deepEqual(analysisSettings, { durationMode: 'auto', clipCount: 7 });
  await review.getByLabel('End for Short reaction', { exact: true }).fill('15');
  await review.getByText('15.0s', { exact: true }).waitFor();
  const request = review.waitForRequest('**/api/jobs/range-review/render');
  await review.getByRole('button', { name: 'Generate 2 clips', exact: true }).click();
  await request;
  await review.getByRole('button', { name: 'Generate 2 clips', exact: true }).waitFor();
  assert.deepEqual(submitted, [{ id: 'short', start: 0, end: 15 }, { id: 'long', start: 200, end: 390 }]);
  await review.screenshot({ path: 'test-artifacts/recording-natural-ranges.png', fullPage: true });
  await review.close();
  assert.deepEqual(errors, []); console.log('Desktop/mobile browser checks passed; screenshots saved to test-artifacts/.');
} finally { await browser.close(); server?.closeAllConnections(); server?.close(); }
