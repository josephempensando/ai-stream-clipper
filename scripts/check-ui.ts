import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createApp } from '../src/server/app.js';

const external = process.argv[2];
const server = external ? null : (await createApp(path.resolve('test-artifacts/ui-data'))).app.listen(3001, '127.0.0.1');
if (server) await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const browser = await chromium.launch({ headless: true, ...(existsSync(edge) ? { executablePath: edge } : {}) });
try {
  await mkdir('test-artifacts', { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(external || 'http://127.0.0.1:3001');
  await page.getByRole('heading', { name: 'Long streams. Short-form gold.' }).waitFor();
  await page.getByRole('button', { name: 'Analyze authorized recording', exact: true }).click();
  assert.match(await page.locator('.recipe-grid').innerText(), /AI chosen/);
  assert.doesNotMatch(await page.locator('main').innerText(), /30–60|Minimum 30 seconds/);
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
  assert.deepEqual(errors, []); console.log('Desktop/mobile browser checks passed; screenshots saved to test-artifacts/.');
} finally { await browser.close(); server?.closeAllConnections(); server?.close(); }
