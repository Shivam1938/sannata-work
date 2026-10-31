import { Worker } from 'bullmq';
import { config } from '../config/index.js';
import { logger } from '../config/logger.js';
import { Monitor } from '../models/Monitor.js';
import { CheckResult } from '../models/CheckResult.js';
import { performCheck, saveCheckResult, reclassifyAsColdStartIfNeeded } from '../services/checker.js';
import { handleSuccessfulCheck, handleFailedCheck } from '../services/incident.js';
import { schedulerService, MONITOR_QUEUE_NAME, CLEANUP_QUEUE_NAME } from '../queues/scheduler.js';
import { User } from '../models/User.js';
import { isScheduledCheckDue, isValidMonitorInterval } from '../services/monitoring-interval.js';
import { getRedisClient } from '../config/redis.js';

export interface WorkerRuntime {
  close(): Promise<void>;
}

let startup: Promise<WorkerRuntime> | undefined;

async function processMonitorJob(monitorId: string): Promise<void> {
  const monitor = await Monitor.findById(monitorId).select(
    '+consecutiveFailures name url method headers body bodyType authType authCredentials intervalSeconds timeoutMs expectedStatusCodes assertions coldStartAware keepAliveEnabled failureThreshold status userId currentIncidentId lastCheckedAt'
  );

  if (!monitor) {
    logger.warn({ monitorId }, 'Monitor not found, skipping job');
    return;
  }

  if (monitor.status === 'paused') {
    logger.debug({ monitorId }, 'Monitor paused, skipping job');
    return;
  }

  const owner = await User.findById(monitor.userId).select('plan proExpiresAt');
  const proActive = owner?.plan === 'pro' && (!owner.proExpiresAt || owner.proExpiresAt.getTime() > Date.now());
  const plan = proActive ? 'pro' : 'free';
  if (!owner || !isValidMonitorInterval(monitor.intervalSeconds, plan)) {
    await schedulerService.removeMonitorJob(monitorId);
    logger.warn(
      { monitorId, intervalSeconds: monitor.intervalSeconds, plan },
      'Skipped scheduled check because its interval is not allowed on the current plan',
    );
    return;
  }

  if (!isScheduledCheckDue(monitor.lastCheckedAt, monitor.intervalSeconds)) {
    logger.info(
      { monitorId, intervalSeconds: monitor.intervalSeconds, lastCheckedAt: monitor.lastCheckedAt },
      'Skipping scheduled check because the configured interval has not elapsed',
    );
    return;
  }

  logger.debug({ monitorId, name: monitor.name, url: monitor.url }, 'Running check');
  const outcome = await performCheck(monitor);

  if (outcome.success && monitor.coldStartAware && outcome.attempts > 1) {
    outcome.classification = 'cold_start';
  }

  const checkResult = await saveCheckResult(monitor, outcome);

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
      outcome.classification = 'slow';
      checkResult.classification = 'slow';
      await CheckResult.findByIdAndUpdate(checkResult._id, { classification: 'slow' });
    }
  }

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
    const result = await CheckResult.deleteMany({ userId: user._id, checkedAt: { $lt: cutoff } });
    deleted += result.deletedCount;
  }

  logger.info({ deleted }, 'Retention cleanup complete');
}

async function initializeWorkers(): Promise<WorkerRuntime> {
  const redis = getRedisClient();
  const monitorWorker = new Worker(
    MONITOR_QUEUE_NAME,
    async (job) => {
      const { monitorId } = job.data as { monitorId: string };
      await processMonitorJob(monitorId);
    },
    { connection: redis, concurrency: config.workerConcurrency }
  );
  const cleanupWorker = new Worker(
    CLEANUP_QUEUE_NAME,
    async () => processCleanupJob(),
    { connection: redis, concurrency: 1 }
  );

  monitorWorker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Monitor check job failed');
  });
  monitorWorker.on('error', (err) => logger.error({ err }, 'Monitor worker error'));
  cleanupWorker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Cleanup job failed');
  });
  cleanupWorker.on('error', (err) => logger.error({ err }, 'Cleanup worker error'));

  try {
    await schedulerService.reconcile();
    await schedulerService.scheduleCleanup();
  } catch (error) {
    await Promise.all([monitorWorker.close(), cleanupWorker.close()]);
    throw error;
  }

  logger.info({ concurrency: config.workerConcurrency }, 'Worker started');
  let closePromise: Promise<void> | undefined;
  return {
    close() {
      closePromise ??= Promise.all([monitorWorker.close(), cleanupWorker.close()]).then(() => undefined);
      return closePromise;
    },
  };
}

export function startWorkers(): Promise<WorkerRuntime> {
  startup ??= initializeWorkers().catch((error: unknown) => {
    startup = undefined;
    throw error;
  });
  return startup;
}
