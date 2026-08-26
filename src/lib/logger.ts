/**
 * Structured logging.
 *
 * Credentials never reach the log. `redact` covers the paths secrets could
 * plausibly travel through — Tally config, auth payloads, headers
 * (build spec §47).
 */

import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [
      'password',
      'passwordHash',
      '*.password',
      '*.passwordHash',
      'token',
      '*.token',
      'tokenHash',
      '*.tokenHash',
      'authorization',
      'req.headers.authorization',
      'req.headers.cookie',
      'headers.cookie',
      'AUTH_SECRET',
      'DATABASE_URL',
      'config.password',
      'config.username',
      'tally.password',
    ],
    censor: '[redacted]',
  },
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
});

export const importLogger = logger.child({ scope: 'import' });
export const parserLogger = logger.child({ scope: 'parser' });
export const tallyLogger = logger.child({ scope: 'tally' });
export const authLogger = logger.child({ scope: 'auth' });
