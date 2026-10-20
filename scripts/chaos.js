
import { ALL } from '../tests/scenarios.js';
import { chaos } from '../tests/lib.js';

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'down') { console.log(JSON.stringify((await chaos({ provider: args[0] || 'a', down: true })).state)); process.exit(0); }
if (cmd === 'up') { console.log(JSON.stringify((await chaos({ provider: '*', reset: true })).state)); process.exit(0); }
if (cmd === 'latency') { console.log(JSON.stringify((await chaos({ provider: '*', latency_min_ms: +args[0], latency_max_ms: +args[1] })).state)); process.exit(0); }

const names = !cmd ? ['t1', 't2', 't4', 't5'] : cmd === 'all' ? Object.keys(ALL) : [cmd, ...args];
let failed = 0;
for (const n of names) {
  if (!ALL[n]) { console.error(`unknown scenario ${n}`); process.exit(2); }
  const t0 = Date.now();
  try { await ALL[n](); console.log(`PASS  ${n.padEnd(7)} ${((Date.now() - t0) / 1000).toFixed(1)}s`); }
  catch (e) { failed++; console.log(`FAIL  ${n.padEnd(7)} ${e.message.split('\n')[0]}`); }
}
await chaos({ provider: '*', reset: true });
console.log(failed ? `\n${failed} scenario(s) failed` : '\nall scenarios passed');
process.exit(failed ? 1 : 0);
