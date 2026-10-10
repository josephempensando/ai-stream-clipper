export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfter = 0) { super(message); }
}
export async function api<T>(path: string, body?: unknown, method: 'POST' | 'PUT' = 'POST'): Promise<T> {
  const response = await fetch(`/api${path}`, body === undefined ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json() as T & { error?: string; retryAfter?: number };
  if (!response.ok) throw new ApiError(data.error || `Request failed (${response.status})`, response.status, Number(response.headers.get('Retry-After')) || data.retryAfter || 0);
  return data;
}
export function uploadRecording(form: FormData, onProgress: (percent: number) => void): Promise<import('../shared/types.js').Job> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest(); request.open('POST', '/api/jobs/upload');
    request.upload.onprogress = e => { if (e.lengthComputable) onProgress(Math.round(e.loaded / e.total * 100)); };
    request.onload = () => {
      try { const data = JSON.parse(request.responseText); if (request.status >= 400) reject(new Error(data.error || 'Upload failed.')); else resolve(data); }
      catch { reject(new Error('Invalid server response.')); }
    };
    request.onerror = () => reject(new Error('Upload connection failed.')); request.send(form);
  });
}
