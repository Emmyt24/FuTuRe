import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import pkg from '@prisma/client';
const { PrismaClient } = pkg;
import logger from '../config/logger.js';

const { Pool } = pg;

// Connection pool — reused across all requests
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// Optional read-replica pool (e.g. RDS reader endpoint). Falls back to primary.
const readUrl = process.env.DATABASE_READ_URL;
const hasReplica = Boolean(readUrl) && readUrl !== process.env.DATABASE_URL;
const readPool = hasReplica
  ? new Pool({ connectionString: readUrl, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 })
  : null;

const READ_OPS = new Set(['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy']);

// Latency metrics: primary vs replica
export const dbMetrics = {
  primary: { count: 0, totalMs: 0 },
  replica: { count: 0, totalMs: 0 },
};

function createClient(p, target) {
  const client = new PrismaClient({
    adapter: new PrismaPg(p),
    log: [
      { emit: 'event', level: 'error' },
      { emit: 'event', level: 'warn' },
    ],
  });
  client.$on('error', (e) => logger.error('db.error', { target, message: e.message }));
  client.$on('warn',  (e) => logger.warn('db.warn',  { target, message: e.message }));
  return client.$extends({
    query: {
      async $allOperations({ args, query }) {
        const start = performance.now();
        try {
          return await query(args);
        } finally {
          const m = dbMetrics[target];
          m.count += 1;
          m.totalMs += performance.now() - start;
        }
      },
    },
  });
}

const prismaWrite = createClient(pool, 'primary');
const prismaRead = readPool ? createClient(readPool, 'replica') : prismaWrite;

// Primary client that transparently routes read-only model queries to the replica.
// Writes and interactive $transaction always hit the primary. Use `withPrimary()`
// (or prismaWrite directly) for read-your-own-writes flows.
let forcePrimaryDepth = 0;
const prisma = readPool
  ? prismaWrite.$extends({
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            if (forcePrimaryDepth === 0 && READ_OPS.has(operation)) {
              const delegate = prismaRead[model.charAt(0).toLowerCase() + model.slice(1)];
              return delegate[operation](args);
            }
            return query(args);
          },
        },
      },
    })
  : prismaWrite;

/** Run fn with all queries pinned to the primary (read-your-own-writes). */
export async function withPrimary(fn) {
  forcePrimaryDepth += 1;
  try {
    return await fn(prismaWrite);
  } finally {
    forcePrimaryDepth -= 1;
  }
}

export function getDBMetrics() {
  const avg = ({ count, totalMs }) => ({ count, avgMs: count ? totalMs / count : 0 });
  return { replicaEnabled: Boolean(readPool), primary: avg(dbMetrics.primary), replica: avg(dbMetrics.replica) };
}

export { prismaRead, prismaWrite };

export async function connectDB() {
  await prismaWrite.$connect();
  if (readPool) await prismaRead.$connect();
  logger.info('db.connected', { replica: Boolean(readPool) });
}

export async function disconnectDB() {
  await prismaWrite.$disconnect();
  if (readPool) {
    await prismaRead.$disconnect();
    await readPool.end();
  }
  await pool.end();
  logger.info('db.disconnected');
}

export async function checkDBHealth() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { status: 'ok' };
  } catch (err) {
    logger.error('db.healthCheck.failed', { error: err.message });
    return { status: 'error', error: err.message };
  }
}

export default prisma;
