import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { config } from './config.js';
import { TwitchApiError, TwitchHttp } from './twitch-http.js';
import type { ViewerStatus } from '../shared/types.js';

interface OAuthOptions { clientId: string; secret: string; redirectUri: string; appOrigin: string }
interface Session {
  access: string; refresh: string; userId: string; login: string; expires: number; validated: number;
  deadline: number; refreshing: Promise<void> | null;
}
const tokenSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1), expires_in: z.number().positive() });
const identitySchema = z.object({ client_id: z.string(), user_id: z.string().min(1), login: z.string(), scopes: z.array(z.string()), expires_in: z.number().positive() });
const opaque = () => randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest();
export function validateOAuthRedirects(callback: string, origin: string): void {
  const c = new URL(callback); const a = new URL(origin);
  const local = (url: URL) => url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password && [String(config.port), '5173'].includes(url.port) && !url.search && !url.hash;
  if (!local(c) || !local(a) || c.origin !== a.origin || c.pathname !== '/api/twitch/oauth/callback' || a.pathname !== '/') throw new Error('Twitch OAuth redirect must be /api/twitch/oauth/callback on the same local origin as TWITCH_APP_ORIGIN (port 5173 or PORT).');
}
export class TwitchOAuth {
  private readonly http: TwitchHttp;
  private readonly pending = new Map<string, { browserHash: Buffer; expires: number }>();
  private readonly sessions = new Map<string, Session>();
  private readonly validationTimer: NodeJS.Timeout;
  readonly configured: boolean;
  constructor(readonly options: OAuthOptions = { clientId: config.twitchClientId, secret: config.twitchSecret, redirectUri: config.twitchRedirectUri, appOrigin: config.twitchAppOrigin }, request: typeof fetch = fetch, private readonly now: () => number = Date.now) {
    validateOAuthRedirects(options.redirectUri, options.appOrigin);
    this.http = new TwitchHttp(request); this.configured = !!(options.clientId && options.secret);
    // Twitch requires validation at session establishment and at least hourly afterward.
    this.validationTimer = setInterval(() => {
      this.prune();
      for (const [key, session] of this.sessions) void this.ensure(session).catch(error => { if (error instanceof TwitchApiError && [401, 403].includes(error.status)) this.sessions.delete(key); });
    }, 5 * 60_000); this.validationTimer.unref();
  }
  close(): void { clearInterval(this.validationTimer); this.sessions.clear(); this.pending.clear(); }
  private prune(): void {
    for (const [key, value] of this.pending) if (value.expires < this.now()) this.pending.delete(key);
    for (const [key, value] of this.sessions) if (value.deadline < this.now()) this.sessions.delete(key);
  }
  begin(): { url: string; browser: string } {
    if (!this.configured) throw new Error('Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET on the server, then register the exact TWITCH_REDIRECT_URI in your Twitch application.');
    this.prune(); if (this.pending.size >= 64) throw new TwitchApiError('Too many pending connections. Try again in ten minutes.', 429, 600);
    const state = opaque(); const browser = opaque();
    this.pending.set(state, { browserHash: digest(browser), expires: this.now() + 600_000 });
    const url = new URL('https://id.twitch.tv/oauth2/authorize');
    url.search = new URLSearchParams({ client_id: this.options.clientId, redirect_uri: this.options.redirectUri, response_type: 'code', scope: 'clips:edit', state, force_verify: 'true' }).toString();
    return { url: url.toString(), browser };
  }
  async finish(state: string, browser: string, code: string, denied = false): Promise<string> {
    this.prune(); const pending = this.pending.get(state);
    if (!pending || !browser || !timingSafeEqual(pending.browserHash, digest(browser))) throw new TwitchApiError('OAuth state is invalid, expired or belongs to another browser. Connect Twitch again.', 401);
    this.pending.delete(state);
    if (denied || !code) throw new TwitchApiError('Twitch connection was declined. Connect again when ready.', 401);
    const result = tokenSchema.parse(await this.exchange({ grant_type: 'authorization_code', code, redirect_uri: this.options.redirectUri }));
    const identity = await this.validate(result.access_token);
    const key = opaque();
    // Tokens are intentionally memory-only; a server restart requires reconnecting.
    this.sessions.set(key, { access: result.access_token, refresh: result.refresh_token, userId: identity.user_id, login: identity.login, expires: this.now() + Math.min(result.expires_in, identity.expires_in) * 1000, validated: this.now(), deadline: this.now() + 86_400_000, refreshing: null });
    return key;
  }
  status(key: string): ViewerStatus {
    this.prune(); const session = this.sessions.get(key);
    return { configured: this.configured, connected: !!session, login: session?.login || null, userId: session?.userId || null };
  }
  disconnect(key: string): void { this.sessions.delete(key); }
  private exchange(params: Record<string, string>): Promise<unknown> {
    return this.http.call('https://id.twitch.tv/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.options.clientId, client_secret: this.options.secret, ...params }) });
  }
  private async validate(access: string) {
    const identity = identitySchema.parse(await this.http.call('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${access}` } }));
    if (identity.client_id !== this.options.clientId) throw new TwitchApiError('Twitch token belongs to a different client.', 401);
    if (!identity.scopes.includes('clips:edit')) throw new TwitchApiError('Twitch viewer token requires clips:edit scope.', 401);
    return identity;
  }
  private async refresh(session: Session): Promise<void> {
    if (session.refreshing) return session.refreshing;
    session.refreshing = (async () => {
      let result: z.infer<typeof tokenSchema>;
      try { result = tokenSchema.parse(await this.exchange({ grant_type: 'refresh_token', refresh_token: session.refresh })); }
      catch (error) {
        if (error instanceof TwitchApiError && [400, 401, 403].includes(error.status)) throw new TwitchApiError('Twitch session was revoked or expired. Connect Twitch again.', 401);
        throw error;
      }
      const identity = await this.validate(result.access_token);
      if (identity.user_id !== session.userId) throw new TwitchApiError('Twitch refreshed token identity changed. Reconnect.', 401);
      session.access = result.access_token; session.refresh = result.refresh_token; session.expires = this.now() + Math.min(result.expires_in, identity.expires_in) * 1000; session.validated = this.now();
    })();
    try { await session.refreshing; } finally { session.refreshing = null; }
  }
  private async ensure(session: Session): Promise<void> {
    if (session.expires <= this.now() + 60_000) { await this.refresh(session); return; }
    if (this.now() - session.validated >= 50 * 60_000) {
      try {
        const identity = await this.validate(session.access);
        if (identity.user_id !== session.userId) throw new TwitchApiError('Twitch session identity changed.', 401);
        session.validated = this.now(); session.expires = this.now() + identity.expires_in * 1000;
      } catch (error) { if (error instanceof TwitchApiError && error.status === 401) await this.refresh(session); else throw error; }
    }
  }
  async withToken<T>(key: string, work: (token: string) => Promise<T>): Promise<T> {
    this.prune(); const session = this.sessions.get(key);
    if (!session) throw new TwitchApiError('Connect Twitch with your viewer account first.', 401);
    try {
      await this.ensure(session);
      try { return await work(session.access); }
      catch (error) {
        if (!(error instanceof TwitchApiError) || error.status !== 401) throw error;
        await this.refresh(session); return await work(session.access);
      }
    } catch (error) { if (error instanceof TwitchApiError && error.status === 401) this.sessions.delete(key); throw error; }
  }
}
