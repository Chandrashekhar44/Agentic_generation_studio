import { config } from './config.js';
import { sleep } from './util.js';
import { log } from './log.js';

export class ProviderError extends Error {
  constructor(msg, { permanent = false, status } = {}) { super(msg); this.permanent = permanent; this.status = status; }
}

class Breaker {
  constructor(name, onChange) { this.name = name; this.state = 'closed'; this.failures = []; this.openedAt = 0; this.probing = false; this.onChange = onChange; }
  allow() {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (Date.now() - this.openedAt < config.breaker.cooldownMs) return false;
      this._set('half_open');
    }
    if (this.probing) return false;      
    this.probing = true;
    return true;
  }
  success() { this.probing = false; this.failures = []; if (this.state !== 'closed') this._set('closed'); }
  failure() {
    this.probing = false;
    const now = Date.now();
    this.failures = this.failures.filter(t => now - t < config.breaker.windowMs).concat(now);
    if (this.state === 'half_open' || this.failures.length >= config.breaker.threshold) { this.openedAt = now; this._set('open'); }
  }
  _set(s) { if (this.state !== s) { this.state = s; log.warn('circuit breaker', { provider: this.name, state: s }); this.onChange?.(this.name, s); } }
}

const jitter = (attempt) => Math.random() * Math.min(config.backoffCapMs, config.backoffBaseMs * 2 ** attempt);

export function createProviderClient({ onAttempt } = {}) {
  const providers = config.providers;
  const breakers = Object.fromEntries(providers.map(p => [p.name, new Breaker(p.name, (name, s) =>
    onAttempt?.({ provider: name, kind: '-', outcome: s === 'open' ? 'breaker_open' : s === 'closed' ? 'breaker_closed' : 'breaker_half_open' }))]));

  async function once(p, kind, body, idemKey, signal) {
    const started = Date.now();
    const rec = (outcome, status) => onAttempt?.({ provider: p.name, kind, outcome, status_code: status, duration_ms: Date.now() - started });
    let res;
    try {
      res = await fetch(`${p.baseUrl}/${kind}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idemKey },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(config.providerTimeoutMs)]),
      });
    } catch (e) {
      if (signal.aborted) throw e;                                  
      const timeout = e.name === 'TimeoutError';
      rec(timeout ? 'timeout' : 'network');
      const err = new ProviderError(timeout ? 'timeout' : `network: ${e.cause?.code || e.message}`);
      err.counts = true; throw err;
    }
    if (res.ok) { const json = await res.json(); rec('ok', res.status); return json; }
    const text = await res.text().catch(() => '');
    if (res.status === 429) {
      rec('http_429', 429);
      const ra = parseFloat(res.headers.get('retry-after')) || 1;
      const err = new ProviderError('rate limited', { status: 429 }); err.retryAfterMs = Math.min(ra * 1000, 15000); throw err;
    }
    if (res.status >= 500) { rec('http_5xx', res.status); const err = new ProviderError(`http ${res.status}`, { status: res.status }); err.counts = true; throw err; }
    rec('permanent', res.status);
    throw new ProviderError(`rejected (${res.status}): ${text.slice(0, 200)}`, { permanent: true, status: res.status });
  }

  /** @returns {{result, provider, degraded}} */
  async function call(kind, body, { idemKey, signal }) {
    let skipped = 0, lastErr;
    for (const [i, p] of providers.entries()) {
      const br = breakers[p.name];
      if (!br.allow()) { skipped++; continue; }
      for (let attempt = 0; attempt < config.providerAttemptsPerProvider; attempt++) {
        try {
          const result = await once(p, kind, body, idemKey, signal);
          br.success();
          return { result, provider: p.name, degraded: i > 0 };
        } catch (e) {
          if (signal.aborted) { br.probing = false; throw e; }
          if (e.permanent) { br.success(); throw e; }               
          lastErr = e;
          if (e.counts) br.failure();
          else br.probing = false;                                 
          if (br.state === 'open') break;                          
          if (attempt + 1 < config.providerAttemptsPerProvider)
            await sleep(Math.max(e.retryAfterMs || 0, jitter(attempt)), signal);
        }
      }
    }
    const err = new ProviderError(skipped === providers.length ? 'all provider circuits open' : `all providers failed: ${lastErr?.message}`);
    throw err;
  }
  return { call, breakers };
}
