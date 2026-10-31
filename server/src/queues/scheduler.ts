import { Queue } from 'bullmq';
import { getRedisClient } from '../config/redis.js';
import { Monitor } from '../models/Monitor.js';
import { User } from '../models/User.js';
import type { IMonitor } from '../models/Monitor.js';
import { logger } from '../config/logger.js';
import { isValidMonitorInterval, minimumMonitorInterval, MAX_MONITOR_INTERVAL_SECONDS } from '../services/monitoring-interval.js';
import { createError } from '../middleware/errorHandler.js';

export const MONITOR_QUEUE_NAME = 'monitor-checks';
export const CLEANUP_QUEUE_NAME = 'cleanup-jobs';
const monitorRepeatKey = (monitorId: string) => `monitor-${monitorId}`;
const legacyMonitorJobId = (monitorId: string) => `monitor:${monitorId}`;

let monitorQueue: Queue | null = null;
let cleanupQueue: Queue | null = null;

export function getMonitorQueue(): Queue {
  if (!monitorQueue) {
    monitorQueue = new Queue(MONITOR_QUEUE_NAME, {
      connection: getRedisClient(),
      defaultJobOptions: {
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 200 },
      },
    });
  }
  return monitorQueue;
}

export function getCleanupQueue(): Queue {
  if (!cleanupQueue) {
    cleanupQueue = new Queue(CLEANUP_QUEUE_NAME, {
      connection: getRedisClient(),
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: { count: 50 },
      },
    });
  }
  return cleanupQueue;
}

export async function closeSchedulerQueues(): Promise<void> {
  const queues = [monitorQueue, cleanupQueue].filter((queue): queue is Queue => queue !== null);
  monitorQueue = null;
  cleanupQueue = null;
  await Promise.all(queues.map((queue) => queue.close()));
}

class SchedulerService {
  /**
   * Schedule a repeatable BullMQ job for a monitor.
   * Uses the monitor's _id as the repeatable job key.
   */
  async scheduleMonitor(monitor: IMonitor): Promise<void> {
    const queue = getMonitorQueue();
    const monitorId = monitor._id.toString();

    // Add small jitter (0–30s) to avoid all monitors firing simultaneously
    const jitterMs = Math.floor(Math.random() * 30_000);

    const owner = await User.findById(monitor.userId).select('plan proExpiresAt');
    const proActive = owner?.plan === 'pro' && (!owner.proExpiresAt || owner.proExpiresAt.getTime() > Date.now());
    const plan = proActive ? 'pro' : 'free';
    if (!owner || !isValidMonitorInterval(monitor.intervalSeconds, plan)) {
      throw createError(
        `Monitor interval must be between ${minimumMonitorInterval(plan)} and ${MAX_MONITOR_INTERVAL_SECONDS} seconds for the current plan.`,
        400,
        'INVALID_MONITOR_INTERVAL',
      );
    }
    await queue.add(
      'check',
      { monitorId },
      {
        repeat: {
          every: monitor.intervalSeconds * 1000,
          key: monitorRepeatKey(monitorId),
        },
        jobId: monitorRepeatKey(monitorId),
        delay: jitterMs,
        priority: proActive ? 1 : 10,
      }
    );

    logger.info(
      { monitorId, intervalSeconds: monitor.intervalSeconds },
      'Scheduled monitor job'
    );
  }

  /**
   * Remove the repeatable job for a monitor (on pause or delete).
   */
  async removeMonitorJob(monitorId: string): Promise<void> {
    const queue = getMonitorQueue();
    const repeatableJobs = await queue.getRepeatableJobs();
    const key = monitorRepeatKey(monitorId);
    if (repeatableJobs.some((job) => job.key === key)) {
      await queue.removeRepeatableByKey(key);
      logger.info({ monitorId }, 'Removed monitor job');
    }
    await this.removeLegacyMonitorJobs(monitorId, repeatableJobs);
  }

  private async removeLegacyMonitorJobs(
    monitorId: string,
    repeatableJobs: Awaited<ReturnType<Queue['getRepeatableJobs']>>,
  ): Promise<void> {
    const queue = getMonitorQueue();
    const intervals = new Set(
      repeatableJobs
        .filter((job) => job.name === 'check' && job.every)
        .map((job) => Number(job.every))
        .filter((interval) => Number.isInteger(interval) && interval > 0),
    );
    for (const every of intervals) {
      await queue.removeRepeatable('check', { every }, legacyMonitorJobId(monitorId));
    }
  }

  /** Rebuild a user's repeatable jobs after a plan change so priority is applied immediately. */
  async rescheduleUserMonitors(userId: string): Promise<void> {
    const monitors = await Monitor.find({ userId, status: { $ne: 'paused' } });
    for (const monitor of monitors) {
      await this.removeMonitorJob(monitor._id.toString());
      await this.scheduleMonitor(monitor);
    }
  }

  /**
   * On startup, reconcile: every non-paused monitor must have a repeatable job.
   * Removes jobs for deleted/paused monitors and adds missing ones.
   */
  async reconcile(): Promise<void> {
    logger.info('Starting scheduler reconciliation');
    const queue = getMonitorQueue();

    // Get all current repeatable jobs
    const repeatableJobs = await queue.getRepeatableJobs();
    const scheduledJobs = new Map(
      repeatableJobs
        .filter((job) => job.name === 'check' && job.key.startsWith('monitor-'))
        .map((job) => [job.key.slice('monitor-'.length), job]),
    );
    const scheduledIds = new Set(scheduledJobs.keys());

    const [activeMonitors, pausedMonitors] = await Promise.all([
      Monitor.find({ status: { $ne: 'paused' } }).select('_id intervalSeconds userId'),
      Monitor.find({ status: 'paused' }).select('_id'),
    ]);
    const activeIds = new Set(activeMonitors.map((m) => m._id.toString()));

    // Remove jobs for monitors that no longer exist or are paused
    for (const jobId of scheduledIds) {
      if (!activeIds.has(jobId)) {
        await queue.removeRepeatableByKey(monitorRepeatKey(jobId));
      }
    }
    for (const monitor of pausedMonitors) {
      await this.removeMonitorJob(monitor._id.toString());
    }

    // Add jobs for monitors that don't have one
    for (const monitor of activeMonitors) {
      const id = monitor._id.toString();
      const currentJob = scheduledJobs.get(id);
      const owner = await User.findById(monitor.userId).select('plan proExpiresAt');
      const proActive = owner?.plan === 'pro' && (!owner.proExpiresAt || owner.proExpiresAt.getTime() > Date.now());
      const plan = proActive ? 'pro' : 'free';
      if (!owner || !isValidMonitorInterval(monitor.intervalSeconds, plan)) {
        await this.removeMonitorJob(id);
        logger.warn(
          { monitorId: id, intervalSeconds: monitor.intervalSeconds, plan },
          'Monitor scheduling skipped because its interval is not allowed on the current plan',
        );
        continue;
      }
      if (!currentJob || Number(currentJob.every) !== monitor.intervalSeconds * 1000) {
        await this.removeMonitorJob(id);
        await this.scheduleMonitor(monitor);
      } else {
        await this.removeLegacyMonitorJobs(id, repeatableJobs);
      }
    }

    logger.info(
      { active: activeIds.size, scheduled: scheduledIds.size },
      'Reconciliation complete'
    );
  }

  /**
   * Schedule the daily cleanup job (repeats every 24h).
   */
  async scheduleCleanup(): Promise<void> {
    const queue = getCleanupQueue();
    await queue.add(
      'retention-cleanup',
      {},
      {
        repeat: { every: 24 * 60 * 60 * 1000 },
        jobId: 'daily-retention-cleanup',
      }
    );
    logger.info('Scheduled daily retention cleanup job');
  }
}

export const schedulerService = new SchedulerService();
