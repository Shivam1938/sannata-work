import 'dotenv/config';
import http from 'http';
import mongoose from 'mongoose';
import { config } from '../config/index.js';
import { logger } from '../config/logger.js';
import { connectDatabase } from '../config/database.js';
import { getRedisClient, closeRedis } from '../config/redis.js';
import { closeSchedulerQueues } from '../queues/scheduler.js';
import { startWorkers } from './runtime.js';

const WORKER_HEALTH_PORT = config.port + 1;

async function start() {
  let healthServer: http.Server | undefined;
  let shutdownPromise: Promise<void> | undefined;
  try {
    await connectDatabase();
    getRedisClient();
    const workers = await startWorkers();

    healthServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', worker: 'running', timestamp: new Date().toISOString() }));
    });
    healthServer.listen(WORKER_HEALTH_PORT, () => {
      logger.info({ port: WORKER_HEALTH_PORT }, 'Worker health check server started');
    });

    const shutdown = (signal: string) => {
      if (shutdownPromise) return shutdownPromise;
      logger.info({ signal }, 'Worker shutting down...');
      shutdownPromise = (async () => {
        await workers.close();
        if (healthServer?.listening) {
          await new Promise<void>((resolve, reject) => {
            healthServer!.close((error) => error ? reject(error) : resolve());
          });
        }
        await closeSchedulerQueues();
        await mongoose.disconnect();
        await closeRedis();
        logger.info('Worker stopped gracefully');
      })();
      return shutdownPromise;
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM').catch((err) => {
      logger.error({ err }, 'Worker shutdown failed');
      process.exitCode = 1;
    }));
    process.on('SIGINT', () => void shutdown('SIGINT').catch((err) => {
      logger.error({ err }, 'Worker shutdown failed');
      process.exitCode = 1;
    }));
  } catch (err) {
    logger.fatal({ err }, 'Failed to start worker');
    await closeSchedulerQueues().catch((closeError) => logger.error({ err: closeError }, 'Failed to close queues'));
    await mongoose.disconnect().catch((closeError) => logger.error({ err: closeError }, 'Failed to close MongoDB'));
    await closeRedis().catch((closeError) => logger.error({ err: closeError }, 'Failed to close Redis'));
    process.exit(1);
  }
}

start();
