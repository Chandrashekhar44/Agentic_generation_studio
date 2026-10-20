const w = (level, msg, fields) =>
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, svc: process.env.SERVICE_NAME || 'app', ...fields }) + '\n');
export const log = {
  info: (m, f) => w('info', m, f),
  warn: (m, f) => w('warn', m, f),
  error: (m, f) => w('error', m, f),
};
