import test from 'node:test';
import assert from 'node:assert/strict';
import { developmentApiTarget } from '../vite.config.js';

test('development proxy defaults to backend port and permits an explicit running API override', () => {
  assert.equal(developmentApiTarget({}), 'http://127.0.0.1:3001');
  assert.equal(developmentApiTarget({ PORT: '3002' }), 'http://127.0.0.1:3002');
  assert.equal(developmentApiTarget({ PORT: '3001', DEV_API_PORT: '3003' }), 'http://127.0.0.1:3003');
});
test('development proxy rejects invalid ports and cannot proxy to arbitrary hosts', () => {
  for (const port of ['0', '65536', 'bad', '3001.5', 'https://evil.test']) assert.throws(() => developmentApiTarget({ DEV_API_PORT: port }));
});
