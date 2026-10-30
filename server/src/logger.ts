import 'dotenv/config';

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/sannata',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  jwtSecret: process.env.JWT_SECRET || 'change-me-in-production',
  cookieDomain: process.env.COOKIE_DOMAIN || 'localhost',
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',
  encryptionKey: process.env.ENCRYPTION_KEY || '',
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    botUsername: process.env.TELEGRAM_BOT_USERNAME || '',
    mode: (process.env.TELEGRAM_MODE || 'polling') as 'polling' | 'webhook',
  },
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.EMAIL_FROM || 'Sannata <noreply@sannata.dev>',
  },
  ai: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.AI_MODEL || 'claude-3-haiku-20240307',
  },
  demoMode: process.env.DEMO_MODE === 'true',
  allowPrivateTargets: process.env.ALLOW_PRIVATE_TARGETS === 'true',
  workerConcurrency: parseInt(process.env.WORKER_CONCURRENCY || '10', 10),
  logLevel: process.env.LOG_LEVEL || 'info',
  nodeEnv: process.env.NODE_ENV || 'development',
};

export function validateConfig() {
  if (!config.encryptionKey || config.encryptionKey.length < 64) {
    throw new Error('ENCRYPTION_KEY must be at least 64 hex characters (32 bytes)');
  }
  if (!config.jwtSecret || config.jwtSecret === 'change-me-in-production') {
    if (config.nodeEnv === 'production') {
      throw new Error('JWT_SECRET must be set in production');
    }
  }
}
