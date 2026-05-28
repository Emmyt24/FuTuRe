import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import pkg from '@prisma/client';
const { PrismaClient } = pkg;
import logger from '../config/logger.js';

const { Pool } = pg;

// Configurable query timeout in milliseconds (default: 5 000 ms)
const QUERY_TIMEOUT_MS = parseInt(process.env.DB_QUERY_TIMEOUT_MS ?? '5000', 10);

// Connection pool — reused across all requests
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// Layer 1 — PostgreSQL server-side timeout.
// Set statement_timeout on every new connection so the DB engine itself
// cancels statements that exceed the threshold, freeing the connection.
pool.on('connect', (client) => {
  client.query(`SET statement_timeout = ${QUERY_TIMEOUT_MS}`).catch((err) =>
    logger.error('db.statement_timeout.set.failed', { error: err.message })
  );
});

const adapter = new PrismaPg(pool);

const baseClient = new PrismaClient({
  adapter,
  log: [
    { emit: 'event', level: 'error' },
    { emit: 'event', level: 'warn' },
  ],
});

// Layer 2 — Node.js-side timeout via Prisma client extension.
// A Promise.race wraps every Prisma operation so callers receive a rejected
// promise if the DB hasn't responded within DB_QUERY_TIMEOUT_MS, regardless
// of whether the server-side statement_timeout has fired yet.
const prisma = baseClient.$extends({
  query: {
    $allModels: {
      async $allOperations({ args, query }) {
        const timeout = new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`DB query timed out after ${QUERY_TIMEOUT_MS}ms`)),
            QUERY_TIMEOUT_MS
          )
        );
        return Promise.race([query(args), timeout]);
      },
    },
  },
});

baseClient.$on('error', (e) => logger.error('db.error', { message: e.message, target: e.target }));
baseClient.$on('warn',  (e) => logger.warn('db.warn',  { message: e.message, target: e.target }));

export async function connectDB() {
  await baseClient.$connect();
  logger.info('db.connected');
}

export async function disconnectDB() {
  await baseClient.$disconnect();
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

export { QUERY_TIMEOUT_MS };
export default prisma;
