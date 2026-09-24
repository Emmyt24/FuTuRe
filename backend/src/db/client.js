/**
 * PostgreSQL connection pool with bounded sizing and metrics (ISSUE-064)
 *
 * poolMax = floor(RDS_MAX_CONNECTIONS * 0.7 / MAX_ECS_TASKS), capped by CPU count.
 * In production, DATABASE_URL should point at PgBouncer (see infra/pgbouncer).
 */
import os from 'os';

const RESERVED_RATIO = 0.7;
export const POOL_WAIT_ALERT_THRESHOLD = 5;

export function computePoolMax(env = process.env) {
  const dbMax = parseInt(env.RDS_MAX_CONNECTIONS, 10) || 100;
  const tasks = parseInt(env.MAX_ECS_TASKS, 10) || 10;
  const cpuCap = Math.max(2, os.cpus().length * 4);
  const safeMax = Math.max(1, Math.min(Math.floor((dbMax * RESERVED_RATIO) / tasks), cpuCap));
  const requested = parseInt(env.DB_POOL_MAX, 10);
  if (requested > 0) {
    if (requested > safeMax) {
      console.warn(`[db] DB_POOL_MAX=${requested} exceeds safe bound ${safeMax}; clamping`);
      return safeMax;
    }
    return requested;
  }
  return safeMax;
}

/** Create a pool using an injected Pool class (e.g. from `pg`). */
export function createPool(Pool, env = process.env) {
  return new Pool({
    connectionString: env.DATABASE_URL,
    max: computePoolMax(env),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

/** Prometheus-style metrics for a pg Pool. */
export function getPoolMetrics(pool) {
  const total = pool.totalCount ?? 0;
  const idle = pool.idleCount ?? 0;
  const waiting = pool.waitingCount ?? 0;
  return {
    pg_pool_active_connections: total - idle,
    pg_pool_idle_connections: idle,
    pg_pool_waiting_queries: waiting,
    alert: waiting > POOL_WAIT_ALERT_THRESHOLD,
  };
}

export function formatPoolMetrics(pool) {
  const { alert, ...m } = getPoolMetrics(pool);
  return Object.entries(m).map(([k, v]) => `${k} ${v}`).join('\n') + '\n';
}
