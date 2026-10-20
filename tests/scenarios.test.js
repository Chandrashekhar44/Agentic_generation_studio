import test from 'node:test';
import { ALL } from './scenarios.js';
const T = { timeout: 180000 };
for (const [name, fn] of Object.entries(ALL)) {
  if (name === 't4' && process.env.SKIP_KILL) { test.skip(name); continue; }
  test(name, T, fn);
}
