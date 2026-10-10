import ipaddr from 'ipaddr.js';
import dns from 'node:dns/promises';
import https from 'node:https';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { rm } from 'node:fs/promises';

export function isPublicAddress(address: string): boolean {
  try {
    let ip = ipaddr.parse(address);
    if (ip.kind() === 'ipv6' && (ip as ipaddr.IPv6).isIPv4MappedAddress()) ip = (ip as ipaddr.IPv6).toIPv4Address();
    return ip.range() === 'unicast';
  } catch { return false; }
}
export function validateMediaUrl(raw: string, allowedHosts: string[]): URL {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !allowedHosts.includes(url.hostname.toLowerCase()) || ipaddr.isValid(url.hostname.replace(/^\[|\]$/g, ''))) {
    throw new Error('Media source must be an approved HTTPS hostname without credentials or a custom port.');
  }
  return url;
}
export async function downloadApproved(raw: string, output: string, hosts: string[], maxBytes: number): Promise<void> {
  const url = validateMediaUrl(raw, hosts);
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) throw new Error('Media hostname resolves to a non-public address.');
  const pinned = addresses[0]!;
  try {
    await new Promise<void>((resolve, reject) => {
      const request = https.get(url, {
        agent: false, family: pinned.family,
        lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
      }, response => {
        if (response.statusCode !== 200 || Number(response.headers['content-length'] || 0) > maxBytes) {
          response.destroy(); request.destroy(); reject(new Error('Media download rejected; redirects are not followed.')); return;
        }
        let bytes = 0;
        const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length; callback(bytes > maxBytes ? new Error('Media source exceeds size limit.') : null, chunk);
        } });
        pipeline(response, limiter, createWriteStream(output, { flags: 'wx' })).then(resolve, reject);
      });
      const timer = setTimeout(() => request.destroy(new Error('Media download timed out.')), 30 * 60_000);
      request.setTimeout(30_000, () => request.destroy(new Error('Media download stalled.')));
      request.on('error', reject); request.on('close', () => clearTimeout(timer));
    });
  } catch (error) { await rm(output, { force: true }); throw error; }
}
