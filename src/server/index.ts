import { createApp } from './app.js';
import { config } from './config.js';
import { shutdownOwnedProcesses } from './process.js';
const { app, story } = await createApp();
const server = app.listen(config.port, config.host, () => console.log(`Cutline API: http://${config.host}:${config.port}`));
let stopping = false;
const shutdown = async () => { if (stopping) return; stopping = true; server.close(); try { await Promise.all([story.close(), shutdownOwnedProcesses()]); process.exit(0); } catch { process.exit(1); } };
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
