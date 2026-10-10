import test from 'node:test';
import assert from 'node:assert/strict';
import { TwitchOAuth, validateOAuthRedirects } from '../src/server/twitch-oauth.js';
import { TwitchApiError } from '../src/server/twitch-http.js';

export const oauthOptions = { clientId: 'client', secret: 'server-secret', redirectUri: 'http://127.0.0.1:5173/api/twitch/oauth/callback', appOrigin: 'http://127.0.0.1:5173' };
export function fakeOAuth(overrides: { scopes?: string[]; clientId?: string; now?: () => number } = {}) {
  const requests: { url: URL; init: RequestInit }[] = [];
  const request: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input)); requests.push({ url, init });
    if (url.pathname.endsWith('/token')) return Response.json({ access_token: 'secret-access', refresh_token: 'secret-refresh', expires_in: 3600 });
    return Response.json({ client_id: overrides.clientId || 'client', user_id: '7', login: 'viewer', scopes: overrides.scopes || ['clips:edit'], expires_in: 3600 });
  };
  return { oauth: new TwitchOAuth(oauthOptions, request, overrides.now), requests };
}
test('OAuth state is browser-bound, expiring, single-use and secrets stay out of public status', async t => {
  let now = Date.now(); const { oauth, requests } = fakeOAuth({ now: () => now }); t.after(() => oauth.close());
  const start = oauth.begin(); const url = new URL(start.url);
  assert.equal(url.searchParams.get('response_type'), 'code'); assert.equal(url.searchParams.get('scope'), 'clips:edit');
  const state = url.searchParams.get('state')!;
  await assert.rejects(oauth.finish(state, 'wrong-browser', 'code'), /state|browser/i); assert.equal(requests.length, 0);
  const session = await oauth.finish(state, start.browser, 'code');
  assert.deepEqual(oauth.status(session), { configured: true, connected: true, login: 'viewer', userId: '7' });
  assert.ok(!JSON.stringify(oauth.status(session)).includes('secret'));
  assert.ok(new URLSearchParams(String(requests[0]!.init.body)).get('client_secret') === 'server-secret');
  await assert.rejects(oauth.finish(state, start.browser, 'code'), /state/i);
  const expired = oauth.begin(); now += 600_001;
  await assert.rejects(oauth.finish(new URL(expired.url).searchParams.get('state')!, expired.browser, 'code'), /state|expired/i);
  oauth.disconnect(session); assert.equal(oauth.status(session).connected, false);
});
test('OAuth rejects missing clips:edit and mismatched client IDs before granting session', async t => {
  for (const input of [{ scopes: ['channel:manage:clips'] }, { clientId: 'other' }]) {
    const { oauth } = fakeOAuth(input); t.after(() => oauth.close()); const start = oauth.begin();
    await assert.rejects(oauth.finish(new URL(start.url).searchParams.get('state')!, start.browser, 'code'), /scope|client/i);
  }
});
test('OAuth redirects are fixed local origins and cannot carry injected return URLs', () => {
  assert.doesNotThrow(() => validateOAuthRedirects(oauthOptions.redirectUri, oauthOptions.appOrigin));
  for (const [callback, origin] of [
    ['https://evil.test/api/twitch/oauth/callback', oauthOptions.appOrigin],
    [oauthOptions.redirectUri + '?return=https://evil.test', oauthOptions.appOrigin],
    ['http://127.0.0.1:5173/other', oauthOptions.appOrigin],
    [oauthOptions.redirectUri, 'http://127.0.0.1:5173/evil'],
    [oauthOptions.redirectUri, 'http://localhost:5173'],
  ]) assert.throws(() => validateOAuthRedirects(callback!, origin!));
});
test('viewer call refreshes expired authorization exactly once on 401', async t => {
  const { oauth, requests } = fakeOAuth(); t.after(() => oauth.close()); const start = oauth.begin();
  const session = await oauth.finish(new URL(start.url).searchParams.get('state')!, start.browser, 'code');
  let calls = 0;
  assert.equal(await oauth.withToken(session, async token => { assert.equal(token, 'secret-access'); if (++calls === 1) throw new TwitchApiError('Expired', 401); return 'clip'; }), 'clip');
  assert.equal(requests.filter(r => r.url.pathname.endsWith('/token')).length, 2);
  assert.equal(new URLSearchParams(String(requests.find(r => String(r.init.body).includes('refresh_token'))!.init.body)).get('grant_type'), 'refresh_token');
});
test('viewer call requires browser OAuth and never falls back to app credentials', async t => {
  const { oauth } = fakeOAuth(); t.after(() => oauth.close());
  await assert.rejects(oauth.withToken('', async () => 'bad'), e => e instanceof TwitchApiError && e.status === 401);
});
test('revoked refresh grant removes local session and asks the viewer to reconnect', async t => {
  const request: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (String(init.body).includes('grant_type=refresh_token')) return Response.json({ message: 'Invalid refresh token' }, { status: 400 });
    if (url.pathname.endsWith('/token')) return Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 });
    return Response.json({ client_id: 'client', user_id: '7', login: 'viewer', scopes: ['clips:edit'], expires_in: 3600 });
  };
  const oauth = new TwitchOAuth(oauthOptions, request); t.after(() => oauth.close()); const start = oauth.begin();
  const key = await oauth.finish(new URL(start.url).searchParams.get('state')!, start.browser, 'code');
  await assert.rejects(oauth.withToken(key, async () => { throw new TwitchApiError('Authorization expired. Reconnect Twitch.', 401); }), e => e instanceof TwitchApiError && e.status === 401);
  assert.equal(oauth.status(key).connected, false);
});
test('idle sessions validate within one hour even when created between timer ticks', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] }); let now = Date.now();
  const { oauth, requests } = fakeOAuth({ now: () => now }); t.after(() => oauth.close());
  now += 6 * 60_000; t.mock.timers.tick(6 * 60_000);
  const start = oauth.begin(); await oauth.finish(new URL(start.url).searchParams.get('state')!, start.browser, 'code');
  for (let minute = 7; minute <= 61; minute++) {
    now += 60_000; t.mock.timers.tick(60_000);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.ok(requests.filter(r => r.url.pathname.endsWith('/validate')).length >= 2);
});
