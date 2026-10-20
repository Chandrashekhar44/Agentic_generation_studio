export function rateLimit({ rps, burst }, keyFn, name = 'default') {
  const buckets = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now - b.t > 60000) buckets.delete(k); }, 30000).unref();
  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    const b = buckets.get(key) || { tokens: burst, t: now };
    b.tokens = Math.min(burst, b.tokens + ((now - b.t) / 1000) * rps);
    b.t = now;
    if (b.tokens < 1) {
      const retry = Math.max(1, Math.ceil((1 - b.tokens) / rps));
      buckets.set(key, b);
      res.set('Retry-After', String(retry));
      return res.status(429).json({ error: 'rate_limited', message: `rate limit exceeded (${name})`, retry_after: retry });
    }
    b.tokens -= 1;
    buckets.set(key, b);
    next();
  };
}
