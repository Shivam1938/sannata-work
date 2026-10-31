import { Queue, QueueEvents } from 'bullmq';
import { getRedisClient } from './config/redis.js';
import { Monitor } from './models/Monitor.js';
import { User } from './models/User.js';
import type { IMonitor } from './models/Monitor.js';
import { logger } from './config/logger.js';

export const MONITOR_QUEUE_NAME = 'monitor-checks';
export const CLEANUP_QUEUE_NAME = 'cleanup-jobs';

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
    await queue.add(
      'check',
      { monitorId },
      {
        repeat: { every: monitor.intervalSeconds * 1000 },
        jobId: `monitor:${monitorId}`,
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

    // Get all repeatable jobs and remove the one matching this monitor
    const repeatableJobs = await queue.getRepeatableJobs();
    for (const job of repeatableJobs) {
      if (job.id === `monitor:${monitorId}` || job.key.includes(monitorId)) {
        await queue.removeRepeatableByKey(job.key);
        logger.info({ monitorId }, 'Removed monitor job');
      }
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
    const scheduledIds = new Set(
      repeatableJobs
        .filter((j) => j.id?.startsWith('monitor:'))
        .map((j) => j.id!.replace('monitor:', ''))
    );

    // Get all non-paused monitors
    const activeMonitors = await Monitor.find({ status: { $ne: 'paused' } }).select(
      '_id intervalSeconds userId'
    );
    const activeIds = new Set(activeMonitors.map((m) => m._id.toString()));

    // Remove jobs for monitors that no longer exist or are paused
    for (const jobId of scheduledIds) {
      if (!activeIds.has(jobId)) {
        await this.removeMonitorJob(jobId);
      }
    }

    // Add jobs for monitors that don't have one
    for (const monitor of activeMonitors) {
      const id = monitor._id.toString();
      if (!scheduledIds.has(id)) {
        await this.scheduleMonitor(monitor);
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
