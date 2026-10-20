import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { HttpError, withTenant } from './db.js';
import { isUuid } from './util.js';

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  const [alg, saltHex, keyHex] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const key = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(key, Buffer.from(keyHex, 'hex'));
}
export const signToken = user => jwt.sign({ sub: user.id, email: user.email }, config.jwtSecret, { algorithm: 'HS256', expiresIn: '12h' });

export function authenticate(allowQueryToken = false) {

  return (req, _res, next) => {
    let token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token && allowQueryToken) token = req.query.access_token || '';
    if (!token) return next(new HttpError(401, 'unauthorized', 'missing token'));
    try {
      const p = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
      req.user = { id: p.sub, email: p.email };
      next();
   
    } catch { next(new HttpError(401, 'unauthorized', 'invalid or expired token')); }
  };
}


export function workspaceContext({ source = 'header', ownerOnly = false } = {}) {
  return async (req, _res, next) => {
    try {
      const wid = source === 'param' ? req.params.wid : (req.headers['x-workspace-id'] || req.query.workspace_id);
      if (!isUuid(wid)) throw new HttpError(404, 'not_found', 'workspace not found');
      const role = await withTenant({ userId: req.user.id }, async c => {
        const { rows } = await c.query('SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2', [wid, req.user.id]);
        return rows[0]?.role;
      });
      if (!role) throw new HttpError(404, 'not_found', 'workspace not found');
      if (ownerOnly && role !== 'owner') throw new HttpError(403, 'forbidden', 'owner role required');
      req.ws = { id: wid, role };
      req.ctx = { workspaceId: wid, userId: req.user.id };
      next();
    } catch (e) { next(e); }
  };
}
