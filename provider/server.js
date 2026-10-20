import http from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const env = process.env;
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const defaults = () => ({
  down: false, latency_min_ms: num(env.LATENCY_MIN_MS, 1000), latency_max_ms: num(env.LATENCY_MAX_MS, 20000),
  error_rate: num(env.ERROR_RATE, 0.10), rate_limit_rate: num(env.RATE_LIMIT_RATE, 0.10), hang_rate: num(env.HANG_RATE, 0.02),
});
const state = { a: defaults(), b: defaults() };
if ((env.CHAOS_DOWN || '').split(',').includes('a')) state.a.down = true;
if ((env.CHAOS_DOWN || '').split(',').includes('b')) state.b.down = true;
const stats = { a: { calls: 0, ok: 0, e5xx: 0, e429: 0, hang: 0, replays: 0 }, b: { calls: 0, ok: 0, e5xx: 0, e429: 0, hang: 0, replays: 0 } };
const done = new Map();      // `${provider}:${idemKey}` -> result
const pending = new Map();   // in-flight dedupe

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);
const sha = s => crypto.createHash('sha256').update(s).digest();
const esc = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
const hsl = (h, s, l) => { s /= 100; l /= 100; const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l), f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); return [f(0) * 255, f(8) * 255, f(4) * 255]; };

// Deterministic 640x360 RGB PNG (gradient + translucent circles) derived from prompt+seed. Real image bytes, no external deps.
function pngFor(prompt, seed, scene) {
  const W = 320, H = 180, h = sha(`${prompt}|${seed}|${scene}`);
  const c1 = hsl(h[0] / 255 * 360, 60, 30), c2 = hsl((h[0] / 255 * 360 + 40 + h[1] / 255 * 120) % 360, 65, 48);
  const circles = Array.from({ length: 6 }, (_, i) => ({ x: h[2 + i] / 255 * W, y: h[8 + i] / 255 * H, r: 25 + h[14 + i] / 255 * 90, c: hsl((h[1] / 255 * 360 + i * 30) % 360, 70, 65) }));
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      const t = (x / W + y / H) / 2; let r = c1[0] + (c2[0] - c1[0]) * t, g = c1[1] + (c2[1] - c1[1]) * t, b = c1[2] + (c2[2] - c1[2]) * t;
      for (const ci of circles) if ((x - ci.x) ** 2 + (y - ci.y) ** 2 < ci.r ** 2) { r = r * 0.65 + ci.c[0] * 0.35; g = g * 0.65 + ci.c[1] * 0.35; b = b * 0.65 + ci.c[2] * 0.35; }
      const o = y * (W * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return 'data:image/png;base64,' + png.toString('base64');
}

async function composeMp4(scenes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-'));
  try {
    scenes.forEach((s, i) => fs.writeFileSync(path.join(dir, `f${String(i).padStart(3, '0')}.png`), Buffer.from(s.image_url.split(',')[1], 'base64')));
    const out = path.join(dir, 'out.mp4');
    await new Promise((resolve, reject) => {
      const p = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '1/2', '-i', path.join(dir, 'f%03d.png'), '-vf', 'scale=640:360,format=yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-r', '24', '-movflags', '+faststart', out]);
      let err = ''; p.stderr.on('data', d => (err += d)); p.on('error', reject);
      p.on('close', code => (code === 0 ? resolve() : reject(new Error('ffmpeg failed: ' + err.slice(0, 300)))));
    });
    return fs.readFileSync(out);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const BEATS = ['establishing wide shot', 'close-up on the subject', 'dramatic reveal', 'tracking shot through the action', 'quiet transition', 'climactic moment', 'aftermath', 'final tableau'];

const handlers = {
  plan: body => {
    const n = Math.max(1, Math.min(8, body.scene_count || 3));
    const st = body.style || {};
    return {
      planner_model: 'mock-llm-1',
      scenes: Array.from({ length: n }, (_, i) => ({
        index: i,
        prompt: `${body.prompt} — scene ${i + 1} of ${n}: ${BEATS[i % BEATS.length]}${st.prompt_suffix ? ', ' + st.prompt_suffix : ''}`,
        negative_prompt: st.negative_prompt || '',
        depends_on: i >= 3 ? [i - 3] : [],      
      })),
    };
  },
  image: body => {
    const failList = /\[fail:([^\]]*)\]/.exec(body.prompt || '')?.[1]?.split(',').map(s => s.trim()) ?? [];
    if (failList.includes(String((body.scene_index ?? 0) + 1)) || failList.includes('all')) return { permanent: 'content policy violation (simulated)' };
    return { image_url: pngFor(body.prompt || '', body.seed ?? 0, body.scene_index ?? 0), seed: body.seed ?? 0, width: 320, height: 180, referenced: !!body.reference };
  },
  compose: async body => {
    if (/\[fail:[^\]]*compose[^\]]*\]/.test(body.prompt || '')) return { permanent: 'unsupported media (simulated)' };
    const scenes = body.scenes || [];
    if (!scenes.length) return { permanent: 'no scenes to compose' };
    const mp4 = await composeMp4(scenes);
    return { video_b64: mp4.toString('base64'), mime: 'video/mp4', bytes: mp4.length, duration_s: scenes.length * 2, resolution: '640x360', codec: 'h264', scenes: scenes.map(s => s.index) };
  },
};

const json = (res, code, obj, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise(r => { let b = ''; req.on('data', d => (b += d)); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') return json(res, 200, { ok: true });
  if (url.pathname === '/chaos') {
    if (req.method === 'POST') {
      const b = await readBody(req);
      const targets = b.provider && b.provider !== '*' ? [b.provider] : ['a', 'b'];
      for (const t of targets) {
        if (!state[t]) return json(res, 400, { error: 'unknown provider' });
        if (b.reset) state[t] = defaults();
        for (const k of Object.keys(defaults())) if (b[k] !== undefined) state[t][k] = b[k];
      }
    }
    return json(res, 200, { state, stats });
  }
  const m = /^\/(a|b)\/(plan|image|compose)$/.exec(url.pathname);
  if (!m || req.method !== 'POST') return json(res, 404, { error: 'not found' });
  const [, p, kind] = m;
  const cfg = state[p], st = stats[p];
  const body = await readBody(req);
  const idem = req.headers['idempotency-key'];
  st.calls++;

  if (cfg.down) return json(res, 503, { error: 'provider down (chaos switch)' });
  const key = idem ? `${p}:${idem}` : null;
  if (key && done.has(key)) { st.replays++; return json(res, 200, done.get(key), { 'idempotent-replay': 'true' }); }

  const roll = Math.random();
  if (roll < cfg.hang_rate) { st.hang++; req.on('close', () => {}); return; }                      
  if (roll < cfg.hang_rate + cfg.rate_limit_rate) { st.e429++; return json(res, 429, { error: 'rate limited' }, { 'retry-after': String(Math.ceil(rnd(1, 3))) }); }
  if (roll < cfg.hang_rate + cfg.rate_limit_rate + cfg.error_rate) {
    st.e5xx++; await sleep(rnd(50, 400));
    return json(res, [500, 502, 503][Math.floor(Math.random() * 3)], { error: 'upstream error (simulated)' });
  }

  let work = key && pending.get(key);
  if (!work) {
    work = (async () => { await sleep(rnd(cfg.latency_min_ms, cfg.latency_max_ms)); return handlers[kind](body); })();
    if (key) { pending.set(key, work); work.finally(() => pending.delete(key)); }
  }
  let out;
  try { out = await work; } catch (e) { return json(res, 500, { error: String(e) }); }
  if (out.permanent) return json(res, 422, { error: out.permanent });
  out = { ...out, provider: p };
  if (key) done.set(key, out);
  st.ok++;
  if (!res.destroyed) json(res, 200, out);
}).listen(num(env.PORT, 4000), () => console.log(JSON.stringify({ msg: 'mock providers listening', port: num(env.PORT, 4000), state })));