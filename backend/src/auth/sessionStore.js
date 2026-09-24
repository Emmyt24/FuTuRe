/**
 * Session store with Redis read-through caching and throttled lastActiveAt writes.
 * Avoids an UPDATE on every authenticated request (MVCC bloat / write amplification).
 */
import prisma from '../db/client.js';
import { RedisBackend } from '../cache/redis.js';
import logger from '../config/logger.js';

export const LAST_ACTIVE_THROTTLE_MS = 15 * 60 * 1000;
const redis = new RedisBackend(process.env.REDIS_URL || null);
const connected = redis.connect();
const key = (id) => `session:${id}`;

async function cacheSession(session) {
  const ttlSec = Math.floor((new Date(session.expiresAt).getTime() - Date.now()) / 1000);
  if (ttlSec > 0) await redis.set(key(session.id), session, ttlSec);
}

async function invalidate(ids) {
  await connected;
  await Promise.all(ids.map((id) => redis.delete(key(id))));
}

export async function createSession(userId, expiresAt) {
  const session = await prisma.session.create({ data: { userId, expiresAt } });
  await connected;
  await cacheSession(session);
  return session;
}

export async function getActiveSession(sessionId) {
  if (!sessionId) return null;
  await connected;

  let session = await redis.get(key(sessionId));
  if (!session) {
    session = await prisma.session.findFirst({
      where: { id: sessionId, revokedAt: null, expiresAt: { gt: new Date() } },
    });
    if (!session) return null;
    await cacheSession(session);
  } else if (session.revokedAt || new Date(session.expiresAt) <= new Date()) {
    return null;
  }

  // Throttled, non-blocking activity update
  const last = session.lastActiveAt ? new Date(session.lastActiveAt).getTime() : 0;
  if (Date.now() - last > LAST_ACTIVE_THROTTLE_MS) {
    const lastActiveAt = new Date();
    session = { ...session, lastActiveAt };
    cacheSession(session).catch(() => {});
    prisma.session
      .update({ where: { id: sessionId }, data: { lastActiveAt } })
      .catch((err) => logger.warn('session.lastActiveAt.updateFailed', { sessionId, error: err.message }));
  }
  return session;
}

export async function revokeSession(sessionId) {
  await prisma.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
  await invalidate([sessionId]);
}

export async function revokeAllSessions(userId) {
  const sessions = await prisma.session.findMany({ where: { userId, revokedAt: null }, select: { id: true } });
  await prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  await invalidate(sessions.map((s) => s.id));
}
