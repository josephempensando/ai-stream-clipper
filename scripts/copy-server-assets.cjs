const { mkdirSync, copyFileSync } = require('node:fs');
mkdirSync('dist/server/server/story', { recursive: true });
copyFileSync('src/server/story/forced-align.py', 'dist/server/server/story/forced-align.py');
