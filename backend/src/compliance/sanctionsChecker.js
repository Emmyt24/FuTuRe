// Sanctions screening — integrates with the OFAC SDN API and the locally
// synchronized SanctionsEntity table (see sanctionsSync.js).
// Set SANCTIONS_API_KEY and SANCTIONS_API_URL in your environment.
//
// Fail mode (SANCTIONS_FAIL_MODE, default 'closed'): when the API is
// unconfigured or unreachable, 'closed' blocks the check as a hit pending
// manual review rather than silently passing everyone. Production and
// staging additionally refuse to start at all without SANCTIONS_API_KEY.

import https from 'https';
import logger from '../config/logger.js';
import prisma from '../config/prisma.js';
import redis from '../config/redis.js';

const API_URL  = process.env.SANCTIONS_API_URL  ?? 'https://api.ofac-api.com/v4/search';
const API_KEY  = process.env.SANCTIONS_API_KEY  ?? '';
const MIN_SCORE = parseInt(process.env.SANCTIONS_MIN_SCORE ?? '85', 10);
const FAIL_MODE = (process.env.SANCTIONS_FAIL_MODE ?? 'closed').trim().toLowerCase();
const APP_ENV = (process.env.APP_ENV || process.env.NODE_ENV || 'development').trim().toLowerCase();
const IS_DEPLOYED = APP_ENV === 'production' || APP_ENV === 'staging';

const CACHE_TTL_SECONDS = parseInt(process.env.SANCTIONS_CACHE_TTL ?? '3600', 10);
const CACHE_PREFIX = 'sanctions:screen:';

if (!API_KEY && IS_DEPLOYED) {
  throw new Error(
    `SANCTIONS_API_KEY is not configured; sanctions screening cannot start in ${APP_ENV}. ` +
    'Set SANCTIONS_API_KEY before deploying.'
  );
}

const sanctionsLogger = logger.child({ component: 'sanctions' });

function httpPost(url, body, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request(
      { hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode, body: raw }); }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function cacheKey(fullName, nationality) {
  return `${CACHE_PREFIX}${fullName.trim().toLowerCase()}|${(nationality ?? '').trim().toLowerCase()}`;
}

class SanctionsChecker {
  /**
   * Screen a person against sanctions lists.
   * @param {string} fullName
   * @param {string} [nationality]
   * @returns {Promise<{ hit: boolean, reason?: string, source?: string }>}
   */
  async check(fullName, nationality) {
    const key = cacheKey(fullName, nationality);
    try {
      const cached = await redis.get(key);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (err) {
      sanctionsLogger.warn('sanctions.cache.read_failed', { error: err.message });
    }

    const result = await this._screen(fullName, nationality);

    try {
      await redis.set(key, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS);
    } catch (err) {
      sanctionsLogger.warn('sanctions.cache.write_failed', { error: err.message });
    }

    return result;
  }

  async _screen(fullName, nationality) {
    if (API_KEY) {
      return this._checkViaApi(fullName, nationality);
    }
    logger.error('sanctions.check.unconfigured', {
      message: 'SANCTIONS_API_KEY not set; screening cannot be performed',
      appEnv: APP_ENV,
      failMode: FAIL_MODE,
    });
    if (FAIL_MODE === 'closed') {
      return {
        hit: true,
        reason: 'Sanctions screening is not configured — blocking pending manual review',
        source: 'SCREENING_UNCONFIGURED',
        screeningError: true,
      };
    }
    // No API key — warn and return clear (operator must configure for production)
    sanctionsLogger.warn('SANCTIONS_API_KEY not set; screening skipped. Configure for production.');
    return { hit: false };
  }

  /**
   * Screen a crypto address against the locally synchronized SanctionsEntity
   * table (populated daily by sanctionsSync.js).
   * @param {string} address
   * @returns {Promise<{ hit: boolean, reason?: string, source?: string }>}
   */
  async checkCryptoAddress(address) {
    if (!address) return { hit: false };
    const normalized = address.trim().toLowerCase();
    try {
      const match = await prisma.sanctionsEntity.findFirst({
        where: { cryptoAddresses: { has: normalized } },
        select: { name: true, source: true },
      });
      if (match) {
        return {
          hit: true,
          reason: `Matched sanctioned crypto address: ${match.name}`,
          source: match.source ?? 'OFAC',
        };
      }
      return { hit: false };
    } catch (err) {
      logger.error('sanctions.crypto.lookup_failed', { error: err.message, appEnv: APP_ENV, failMode: FAIL_MODE });
      if (FAIL_MODE === 'closed') {
        return {
          hit: true,
          reason: `Sanctions database unavailable (${err.message}) — blocking pending manual review`,
          source: 'SCREENING_ERROR',
          screeningError: true,
        };
      }
      return { hit: false, warning: `Sanctions database unavailable: ${err.message}` };
    }
  }

  async _checkViaApi(fullName, nationality) {
    try {
      const payload = {
        apiKey: API_KEY,
        minScore: MIN_SCORE,
        sources: ['SDN', 'UN', 'EU'],
        cases: [{ name: fullName, ...(nationality ? { nationality } : {}) }],
      };
      const { status, body } = await httpPost(API_URL, payload, { apiKey: API_KEY });

      if (status !== 200) {
        logger.error('sanctions.api.error_status', { status, appEnv: APP_ENV, failMode: FAIL_MODE });
        if (FAIL_MODE === 'closed') {
          return {
            hit: true,
            reason: `Sanctions API returned ${status} — blocking pending manual review`,
            source: 'SCREENING_ERROR',
            screeningError: true,
          };
        }
        sanctionsLogger.error('API error', { status, body });
        // Fail open with a warning — operator should decide fail-closed policy
        return { hit: false, warning: `Sanctions API returned ${status}` };
      }

      const matches = body?.results?.[0]?.matches ?? [];
      if (matches.length > 0) {
        const top = matches[0];
        return {
          hit: true,
          reason: `Matched sanctions entry: ${top.name} (score: ${top.score}, lists: ${top.sources?.join(', ')})`,
          source: top.sources?.[0] ?? 'UNKNOWN',
        };
      }
      return { hit: false };
    } catch (err) {
      logger.error('sanctions.api.call_failed', { error: err.message, appEnv: APP_ENV, failMode: FAIL_MODE });
      if (FAIL_MODE === 'closed') {
        return {
          hit: true,
          reason: `Sanctions API unavailable (${err.message}) — blocking pending manual review`,
          source: 'SCREENING_ERROR',
          screeningError: true,
        };
      }
      sanctionsLogger.error('API call failed', { error: err.message });
      return { hit: false, warning: `Sanctions API unavailable: ${err.message}` };
    }
  }
}

export default new SanctionsChecker();
