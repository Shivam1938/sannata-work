import { Incident } from '../models/Incident.js';
import { Monitor } from '../models/Monitor.js';
import { User } from '../models/User.js';
import { CheckResult } from '../models/CheckResult.js';
import type { ICheckResult } from '../models/CheckResult.js';
import type { IIncident } from '../models/Incident.js';
import type { IMonitor } from '../models/Monitor.js';
import { sendAlerts } from './alert.js';
import { generateAiSummary } from './ai.js';
import { logger } from '../config/logger.js';

const REMINDER_AFTER_MS = 60 * 60 * 1000; // 1 hour

/**
 * Called after a failed check. Increments consecutive failures and opens an
 * incident when the threshold is reached.
 */
export async function handleFailedCheck(
  monitor: IMonitor,
  checkResult: ICheckResult
): Promise<void> {
  // Atomically increment consecutive failures and return new value
  const updated = await Monitor.findByIdAndUpdate(
    monitor._id,
    { $inc: { consecutiveFailures: 1 } },
    { new: true, select: 'consecutiveFailures failureThreshold currentIncidentId userId' }
  );

  if (!updated) return;

  const { consecutiveFailures, failureThreshold, currentIncidentId } = updated;

  // Already has an open incident — check for reminder
  if (currentIncidentId) {
    const incident = await Incident.findById(currentIncidentId);
    if (incident && incident.status === 'open') {
      // Send a reminder if none sent in last hour
      if (!incident.reminderSentAt || Date.now() - incident.reminderSentAt.getTime() > REMINDER_AFTER_MS) {
        await Incident.findByIdAndUpdate(currentIncidentId, {
          $inc: { failedChecksCount: 1 },
          $set: { lastErrorMessage: checkResult.errorMessage, reminderSentAt: new Date() },
        });
        await sendAlerts(monitor, incident, 'reminder');
      } else {
        await Incident.findByIdAndUpdate(currentIncidentId, {
          $inc: { failedChecksCount: 1 },
          $set: { lastErrorMessage: checkResult.errorMessage },
        });
      }
    }
    return;
  }

  // Not yet at threshold
  if (consecutiveFailures < failureThreshold) return;

  // Open a new incident
  const user = await User.findById(monitor.userId).select('plan proExpiresAt');
  const isPro = user?.plan === 'pro' && (!user.proExpiresAt || user.proExpiresAt.getTime() > Date.now());

  const incident = new Incident({
    monitorId: monitor._id,
    userId: monitor.userId,
    startedAt: new Date(),
    status: 'open',
    firstErrorType: checkResult.errorType,
    failedChecksCount: consecutiveFailures,
    lastErrorMessage: checkResult.errorMessage,
  });
  await incident.save();

  // Link incident to monitor and set status to down
  await Monitor.findByIdAndUpdate(monitor._id, {
    status: 'down',
    currentIncidentId: incident._id,
  });

  logger.info({ monitorId: monitor._id, incidentId: incident._id }, 'Incident opened');

  // Send alerts immediately (don't wait for AI summary to arrive first)
  sendAlerts(monitor, incident, 'down').catch((err) =>
    logger.error({ err }, 'Failed to send down alerts')
  );

  // Generate AI summary asynchronously (give it 5 seconds to complete before proceeding)
  const summaryPromise = generateIncidentSummary(incident, monitor, isPro).catch((error) => {
    logger.error({ error }, 'Automatic incident summary generation failed');
    return null;
  });
  const timeoutPromise = new Promise<null>((r) => setTimeout(() => r(null), 5000));
  const summary = await Promise.race([summaryPromise, timeoutPromise]);

  if (summary) {
    await Incident.findByIdAndUpdate(incident._id, { aiSummary: summary });
  } else {
    // Update asynchronously
    summaryPromise.then(async (s) => {
      if (s) await Incident.findByIdAndUpdate(incident._id, { aiSummary: s });
    }).catch((error) => logger.error({ error, incidentId: incident._id }, 'Failed to persist incident analysis'));
  }
}

/**
 * Called after a successful check. Resets consecutive failures and resolves
 * any open incident.
 */
export async function handleSuccessfulCheck(
  monitor: IMonitor,
  checkResult: ICheckResult
): Promise<void> {
  await Monitor.findByIdAndUpdate(monitor._id, {
    consecutiveFailures: 0,
    status: checkResult.classification === 'cold_start' ? 'up' : 'up',
  });

  if (!monitor.currentIncidentId) return;

  const incident = await Incident.findById(monitor.currentIncidentId);
  if (!incident || incident.status === 'resolved') return;

  const now = new Date();
  const durationSeconds = Math.round((now.getTime() - incident.startedAt.getTime()) / 1000);

  await Incident.findByIdAndUpdate(incident._id, {
    status: 'resolved',
    resolvedAt: now,
    durationSeconds,
  });

  await Monitor.findByIdAndUpdate(monitor._id, { currentIncidentId: null, status: 'up' });

  logger.info({ monitorId: monitor._id, incidentId: incident._id, durationSeconds }, 'Incident resolved');

  // Send recovery alert
  const updatedIncident = await Incident.findById(incident._id);
  if (updatedIncident) {
    sendAlerts(monitor, updatedIncident, 'recovery').catch((err) =>
      logger.error({ err }, 'Failed to send recovery alerts')
    );

    // Generate resolution summary
    const user = await User.findById(monitor.userId).select('plan proExpiresAt');
    const isPro = user?.plan === 'pro' && (!user.proExpiresAt || user.proExpiresAt.getTime() > Date.now());
    generateResolutionSummary(updatedIncident, monitor, isPro)
      .then(async (s) => {
        if (s) await Incident.findByIdAndUpdate(incident._id, { aiSummaryResolved: s });
      })
      .catch(() => {});
  }
}

async function generateIncidentSummary(
  incident: IIncident,
  monitor: IMonitor,
  isPro: boolean
): Promise<string | null> {
  // Get last 10 check results before incident
  const recentChecks = await CheckResult.find({ monitorId: monitor._id })
    .sort({ checkedAt: -1 })
    .limit(10)
    .lean();

  if (isPro) {
    return generateAiSummary('open', monitor, incident, recentChecks);
  }
  return null;
}

async function generateResolutionSummary(
  incident: IIncident,
  monitor: IMonitor,
  isPro: boolean
): Promise<string | null> {
  if (isPro) {
    return generateAiSummary('resolved', monitor, incident, []);
  }
  return null;
}
