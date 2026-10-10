import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
export function developmentApiTarget(env: Record<string, string | undefined>): string {
  const port = Number(env.DEV_API_PORT || env.PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid development API port.');
  return `http://127.0.0.1:${port}`;
}
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '/api': developmentApiTarget({ ...loadEnv(mode, process.cwd(), ''), ...process.env }) } },
  build: { outDir: 'dist/client' },
}));
