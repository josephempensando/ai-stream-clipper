export class TwitchApiError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfter = 0) { super(message); }
}
/** No automatic POST retries: a timeout may have occurred after Twitch accepted a clip. */
export class TwitchHttp {
  private cooldown = new Map<string, number>();
  constructor(private readonly request: typeof fetch = fetch) {}
  async call(url: string | URL, init: RequestInit = {}): Promise<unknown> {
    const target = new URL(url); const headers = new Headers(init.headers);
    const bucket = `${target.hostname}:${headers.get('Authorization') || 'oauth'}`;
    const until = this.cooldown.get(bucket) || 0;
    if (until > Date.now()) throw new TwitchApiError('Twitch rate limit reached. Wait before retrying.', 429, Math.ceil((until - Date.now()) / 1000));
    let response: Response;
    try { response = await this.request(target, { ...init, redirect: 'error', signal: AbortSignal.timeout(20_000) }); }
    catch { throw new TwitchApiError('Twitch request timed out or could not connect. Clip creation is not retried automatically; check Twitch before trying again.', 502); }
    const reset = Number(response.headers.get('Ratelimit-Reset')) * 1000;
    const retry = Number(response.headers.get('Retry-After')) * 1000;
    if (response.status === 429 || response.headers.get('Ratelimit-Remaining') === '0') {
      const deadline = Math.max(Date.now() + (response.status === 429 ? Math.max(retry, 1000) : 0), Number.isFinite(reset) ? reset : 0);
      this.cooldown.set(bucket, Math.min(deadline, Date.now() + 3_600_000));
    }
    if (!response.ok) {
      const messages: Record<number, string> = {
        400: 'Twitch rejected the request. Check the title, channel and whether the category supports clips.',
        401: 'Twitch authorization expired or lacks the required scope. Reconnect Twitch.',
        403: 'Twitch clipping permission denied: clips may be disabled, restricted to followers/subscribers, or your account may be banned or timed out.',
        404: 'Twitch channel or resource is unavailable. Live clipping requires a currently live stream.',
        429: 'Twitch rate limit reached. Wait before retrying.',
      };
      throw new TwitchApiError(messages[response.status] || `Twitch returned ${response.status}. Try again later.`, response.status, response.status === 429 ? Math.max(1, Math.ceil(((this.cooldown.get(bucket) || Date.now()) - Date.now()) / 1000)) : 0);
    }
    return response.json();
  }
}
