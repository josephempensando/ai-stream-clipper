import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const vod = { id: '123', title: 'Test VOD', user_id: '42', user_name: 'CaseOh', duration: '2h', thumbnail_url: '', url: 'https://www.twitch.tv/videos/123', created_at: '2026-10-09T00:00:00Z', view_count: 1000 };
  let zero = false; let connected = false; let saved = false; let ready = false; let creations = 0;
  const clip = { id: 'PublicOne', title: 'Unexpected win', url: 'https://clips.twitch.tv/PublicOne', thumbnail_url: '', duration: 45, view_count: 1234, broadcaster_name: 'CaseOh', creator_name: 'viewer', score: 60, explanation: '1234 public views. Metadata heuristic; content quality is unverified.' };
  const liveClip = () => ({ id: 'LiveOne', title: 'Live highlight', url: 'https://clips.twitch.tv/LiveOne', editUrl: 'https://www.twitch.tv/caseoh_/clip/LiveOne', broadcasterName: 'CaseOh', status: ready ? 'ready' : 'pending', duration: 45, createdAt: new Date().toISOString(), error: null });
  await page.route('**/api/twitch/**', async route => {
    const url = new URL(route.request().url()); const path = url.pathname;
    if (path.endsWith('/oauth/status')) return route.fulfill({ json: { configured: true, connected, userId: connected ? '7' : null, login: connected ? 'viewer' : null } });
    if (path.endsWith('/discover')) return route.fulfill({ json: { vod, clips: zero ? [] : [clip], pages: 1, scanned: 12, matched: zero ? 0 : 1, eligible: zero ? 0 : 1, truncated: false, analysis: 'public-metadata', message: 'Public metadata ranking only; no video/audio AI analysis.' } });
    if (path.endsWith('/live')) return route.fulfill({ json: { broadcaster: { id: '42', login: 'caseoh_', display_name: 'CaseOh' }, live: true, stream: { title: 'Live test', game_name: 'Gaming', viewer_count: 500, id: 'stream', started_at: '' } } });
    if (path.endsWith('/live/clips') && route.request().method() === 'POST') { creations++; saved = true; return route.fulfill({ status: 202, json: liveClip() }); }
    if (path.endsWith('/live/clips')) return route.fulfill({ json: saved ? [liveClip()] : [] });
    if (path.endsWith('/live/clips/LiveOne')) { ready = true; return route.fulfill({ json: liveClip() }); }
    return route.fulfill({ status: 404, json: { error: 'Unexpected route in browser test.' } });
  });
  await page.goto(process.argv[2] || 'http://127.0.0.1:5173');
  await page.getByRole('button', { name: 'Discover existing VOD clips', exact: true }).click();
  await page.getByLabel('Public Twitch VOD URL or ID').fill('https://www.twitch.tv/videos/123');
  await page.getByRole('button', { name: 'Discover clips', exact: true }).click();
  await page.getByRole('heading', { name: 'Unexpected win' }).waitFor();
  assert.equal(await page.getByText('1 clip selected', { exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: /Analyze stream|Generate.*clips/ }).count(), 0);
  await page.getByRole('button', { name: 'Preview Unexpected win' }).click(); assert.ok((await page.locator('iframe[title="Public clip preview"]').getAttribute('src'))?.includes('clip=PublicOne'));
  await mkdir('test-artifacts', { recursive: true }); await page.screenshot({ path: 'test-artifacts/public-clips-desktop.png', fullPage: true });
  zero = true; await page.getByRole('button', { name: 'Discover clips', exact: true }).click(); await page.getByText('0 clips selected', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Create live Twitch clips', exact: true }).click(); await page.getByRole('button', { name: 'Connect Twitch', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Check live status', exact: true }).click(); await page.getByText('LIVE NOW', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Create live clip now', exact: true }).isEnabled(), false);
  connected = true; await page.reload(); await page.getByRole('button', { name: 'Create live Twitch clips', exact: true }).click(); await page.getByText('Connected as viewer', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Check live status', exact: true }).click(); await page.getByText('LIVE NOW', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Create live clip now', exact: true }).click(); await page.getByText('Published', { exact: true }).waitFor(); assert.equal(creations, 1);
  await page.screenshot({ path: 'test-artifacts/live-clips-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: 'test-artifacts/live-clips-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Analyze authorized recording', exact: true }).click(); await page.getByRole('heading', { name: 'Source recording', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Twitch VOD', exact: true }).click(); await page.getByLabel('Twitch VOD URL or ID', { exact: true }).fill('https://evil.test/videos/123'); await page.getByRole('button', { name: 'Look up' }).click(); await page.getByRole('alert').waitFor();
  assert.deepEqual(errors, []); console.log('Twitch browser checks passed: actual counts, previews, live OAuth gate, manual creation, mode switching, mobile layout. APIs mocked; no Twitch clip published.');
} finally { await browser.close(); }
