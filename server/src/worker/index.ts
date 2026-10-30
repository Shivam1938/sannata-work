import 'dotenv/config';
import http from 'http';
import { Worker, QueueEvents } from 'bullmq';
import { config } from '../config/index.js';
import { logger } from '../config/logger.js';
import { connectDatabase } from '../config/database.js';
import { getRedisClient, closeRedis } from '../config/redis.js';
import { Monitor } from '../models/Monitor.js';
import { CheckResult } from '../models/CheckResult.js';
import { performCheck, saveCheckResult, reclassifyAsColdStartIfNeeded } from '../services/checker.js';
import { handleSuccessfulCheck, handleFailedCheck } from '../services/incident.js';
import { schedulerService, MONITOR_QUEUE_NAME, CLEANUP_QUEUE_NAME } from '../queues/scheduler.js';
import { User } from '../models/User.js';

const WORKER_HEALTH_PORT = config.port + 1;

async function processMonitorJob(monitorId: string): Promise<void> {
  const monitor = await Monitor.findById(monitorId).select(
    '+consecutiveFailures name url method headers body bodyType authType authCredentials intervalSeconds timeoutMs expectedStatusCodes assertions coldStartAware keepAliveEnabled failureThreshold status userId currentIncidentId'
  );

  if (!monitor) {
    logger.warn({ monitorId }, 'Monitor not found, skipping job');
    return;
  }

  if (monitor.status === 'paused') {
    logger.debug({ monitorId }, 'Monitor paused, skipping job');
    return;
  }

  logger.debug({ monitorId, name: monitor.name, url: monitor.url }, 'Running check');

  // Perform the check (with retries built in)
  const outcome = await performCheck(monitor);

  // Apply cold-start reclassification based on retry evidence
  if (outcome.success && monitor.coldStartAware) {
    const hadRetryFailure = outcome.attempts > 1;
    if (hadRetryFailure) {
      outcome.classification = 'cold_start';
    }
  }

  // Save the result
  const checkResult = await saveCheckResult(monitor, outcome);

  // After saving, check if we should reclassify based on historical median
  if (outcome.success && monitor.coldStartAware && outcome.classification !== 'cold_start') {
    const isColdStart = await reclassifyAsColdStartIfNeeded(
      checkResult._id.toString(),
      monitorId,
      outcome.responseTimeMs || 0,
      false
    );
    if (isColdStart) {
      outcome.classification = 'cold_start';
      checkResult.classification = 'cold_start';
      await CheckResult.findByIdAndUpdate(checkResult._id, { classification: 'cold_start' });
    } else if (outcome.responseTimeMs && outcome.responseTimeMs > 1000) {
      // Mark as slow if response time > 1s but not cold start
      outcome.classification = 'slow';
      checkResult.classification = 'slow';
      await CheckResult.findByIdAndUpdate(checkResult._id, { classification: 'slow' });
    }
  }

  // Handle incident lifecycle
  if (outcome.success || outcome.classification === 'cold_start' || outcome.classification === 'slow') {
    await handleSuccessfulCheck(monitor, checkResult);
  } else {
    await handleFailedCheck(monitor, checkResult);
  }

  logger.debug(
    {
      monitorId,
      success: outcome.success,
      classification: outcome.classification,
      responseTimeMs: outcome.responseTimeMs,
      statusCode: outcome.statusCode,
      attempts: outcome.attempts,
    },
    'Check complete'
  );
}

async function processCleanupJob(): Promise<void> {
  logger.info('Running retention cleanup');

  const users = await User.find().select('_id plan');
  let deleted = 0;

  for (const user of users) {
    const retentionDays = user.plan === 'pro' ? 30 : 7;
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    const result = await CheckResult.deleteMany({
      userId: user._id,
      checkedAt: { $lt: cutoff },
    });
    deleted += result.deletedCount;
  }

  logger.info({ deleted }, 'Retention cleanup complete');
}

async function start() {
  try {
    await connectDatabase();
    const redis = getRedisClient();

    // Monitor check worker
    const monitorWorker = new Worker(
      MONITOR_QUEUE_NAME,
      async (job) => {
        const { monitorId } = job.data as { monitorId: string };
        await processMonitorJob(monitorId);
      },
      {
        connection: redis,
        concurrency: config.workerConcurrency,
      }
    );

    monitorWorker.on('failed', (job, err) => {
      logger.error({ jobId: job?.id, err }, 'Monitor check job failed');
    });

    monitorWorker.on('error', (err) => {
      logger.error({ err }, 'Monitor worker error');
    });

    // Cleanup worker
    const cleanupWorker = new Worker(
      CLEANUP_QUEUE_NAME,
      async () => {
        await processCleanupJob();
      },
      { connection: redis, concurrency: 1 }
    );

    cleanupWorker.on('failed', (job, err) => {
      logger.error({ jobId: job?.id, err }, 'Cleanup job failed');
    });

    // Reconcile scheduler on startup
    await schedulerService.reconcile();
    await schedulerService.scheduleCleanup();

    // Health check HTTP server
    const healthServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', worker: 'running', timestamp: new Date().toISOString() }));
    });
    healthServer.listen(WORKER_HEALTH_PORT, () => {
      logger.info({ port: WORKER_HEALTH_PORT }, 'Worker health check server started');
    });

    logger.info({ concurrency: config.workerConcurrency }, 'Worker started');

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Worker shutting down...');
      await monitorWorker.close();
      await cleanupWorker.close();
      healthServer.close();
      const mongoose = await import('mongoose');
      await mongoose.default.disconnect();
      await closeRedis();
      logger.info('Worker stopped gracefully');
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    logger.fatal({ err }, 'Failed to start worker');
    process.exit(1);
  }
}

start();
