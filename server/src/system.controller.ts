import { Redis } from 'ioredis';
import { config } from './index.js';
import { logger } from './logger.js';

let redisClient: Redis | null = null;

export function getRedisClient(): Redis {
  if (!redisClient) {
    redisClient = new Redis(config.redisUrl, {
      maxRetriesPerRequest: null, // required for BullMQ
      enableReadyCheck: false,
    });
    redisClient.on('error', (err) => logger.error({ err }, 'Redis error'));
    redisClient.on('connect', () => logger.info('Redis connected'));
  }
  return redisClient;
}

export async function closeRedis() {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}
