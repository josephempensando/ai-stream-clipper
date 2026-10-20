import type { StoryJob } from '../shared/story.js';
export async function storyApi<T>(route: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/story-videos${route}`, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), ...(signal ? { signal } : {}) });
  if (response.status === 204) return undefined as T;
  const data = await response.json(); if (!response.ok) throw new Error(data.error || `Story request failed (${response.status}).`); return data as T;
}
export function uploadStory(form: FormData, signal: AbortSignal, onBytes: (loaded: number, total: number) => void): Promise<StoryJob> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); const abort = () => xhr.abort();
    const cleanup = () => signal.removeEventListener('abort', abort);
    xhr.open('POST', '/api/story-videos'); xhr.responseType = 'json';
    xhr.upload.onprogress = e => { if (e.lengthComputable) onBytes(e.loaded, e.total); };
    xhr.onload = () => { cleanup(); if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response as StoryJob); else reject(new Error(xhr.response?.error || 'Story upload failed.')); };
    xhr.onerror = () => { cleanup(); reject(new Error('Cannot reach the local server.')); };
    xhr.onabort = () => { cleanup(); reject(new DOMException('Upload cancelled.', 'AbortError')); };
    if (signal.aborted) { reject(new DOMException('Upload cancelled.', 'AbortError')); return; }
    signal.addEventListener('abort', abort, { once: true }); xhr.send(form);
  });
}
