import pino from 'pino';
import { config } from './index.js';

export const logger = pino({
  level: config.logLevel,
  transport:
    config.nodeEnv !== 'production'
      ? {
          target: 'pino-pretty',
          options: { colorize: true, ignore: 'pid,hostname', translateTime: 'SYS:standard' },
        }
      : undefined,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.passwordHash',
      '*.password',
      '*.ANTHROPIC_API_KEY',
      '*.GROQ_API_KEY',
      '*.JWT_SECRET',
      '*.ENCRYPTION_KEY',
      '*.SMTP_PASS',
    ],
    censor: '[REDACTED]',
  },
});
