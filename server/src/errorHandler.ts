import type { Response, NextFunction } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { Monitor } from './models/Monitor.js';
import { CheckResult } from './models/CheckResult.js';
import { Incident } from './models/Incident.js';
import { encrypt, decrypt } from './services/crypto.js';
import { performCheck, saveCheckResult } from './services/checker.js';
import { computeStats, computeSeries } from './services/stats.js';
import { schedulerService } from './queues/scheduler.js';
import { createError } from './middleware/errorHandler.js';
import type { AuthRequest } from './middleware/auth.js';
import { logger } from './config/logger.js';
import { handleSuccessfulCheck, handleFailedCheck } from './services/incident.js';

// ─── Plan limits ──────────────────────────────────────────────────────────────
const PLAN_LIMITS = {
  free: { maxMonitors: 5, minIntervalSeconds: 300 },
  pro: { maxMonitors: 50, minIntervalSeconds: 60 },
};

// ─── Schemas ──────────────────────────────────────────────────────────────────
const monitorSchema = z.object({
  name: z.string().min(1).max(200),
  url: z.string().url(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).default('GET'),
  headers: z
    .array(z.object({ key: z.string(), value: z.string(), enabled: z.boolean() }))
    .default([]),
  body: z.string().default(''),
  bodyType: z.enum(['none', 'json', 'text']).default('none'),
  authType: z.enum(['none', 'bearer', 'basic']).default('none'),
  authCredentials: z.string().default(''),
  intervalSeconds: z.number().int().min(60).max(3600),
  timeoutMs: z.number().int().min(1000).max(60000).default(30000),
  expectedStatusCodes: z.array(z.union([z.number(), z.string()])).default(['200-299']),
  assertions: z
    .array(
      z.object({
        type: z.enum(['body_contains', 'json_path_equals']),
        path: z.string().optional(),
        value: z.string(),
      })
    )
    .default([]),
  coldStartAware: z.boolean().default(true),
  keepAliveEnabled: z.boolean().default(false),
  failureThreshold: z.number().int().min(1).max(10).default(2),
  showOnStatusPage: z.boolean().default(true),
});

const testMonitorSchema = z.object({
  url: z.string().url(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).default('GET'),
  headers: z
    .array(z.object({ key: z.string(), value: z.string(), enabled: z.boolean() }))
    .default([]),
  body: z.string().default(''),
  bodyType: z.enum(['none', 'json', 'text']).default('none'),
  authType: z.enum(['none', 'bearer', 'basic']).default('none'),
  authCredentials: z.string().default(''),
  timeoutMs: z.number().int().default(30000),
  expectedStatusCodes: z.array(z.union([z.number(), z.string()])).default(['200-299']),
  assertions: z
    .array(
      z.object({
        type: z.enum(['body_contains', 'json_path_equals']),
        path: z.string().optional(),
        value: z.string(),
      })
    )
    .default([]),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
const SENTINEL = '**encrypted**';

/** Encrypt all header values that are not the sentinel placeholder */
function encryptHeaders(
  headers: { key: string; value: string; enabled: boolean }[]
): { key: string; value: string; enabled: boolean }[] {
  return headers.map((h) => ({
    ...h,
    value: h.value && h.value !== SENTINEL ? encrypt(h.value) : h.value,
  }));
}

/** Replace encrypted header/auth values with the sentinel for API responses */
function maskSensitiveFields(monitor: ReturnType<(typeof Monitor)['prototype']['toObject']>) {
  const masked = { ...monitor };
  if (masked.headers) {
    masked.headers = masked.headers.map((h: { key: string; value: string; enabled: boolean }) => ({
      ...h,
      value: h.value ? SENTINEL : '',
    }));
  }
  if (masked.authCredentials) {
    masked.authCredentials = SENTINEL;
  }
  return masked;
}

// ─── Controllers ──────────────────────────────────────────────────────────────

/** GET /api/monitors */
export async function listMonitors(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const page = Math.max(1, parseInt((req.query.page as string) || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) || '20', 10)));
    const search = (req.query.search as string) || '';
    const status = req.query.status as string | undefined;

    const filter: Record<string, unknown> = { userId: req.userId };
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { url: { $regex: search, $options: 'i' } },
      ];
    }
    if (status && ['up', 'down', 'paused', 'pending'].includes(status)) {
      filter.status = status;
    }

    const [monitors, total] = await Promise.all([
      Monitor.find(filter)
        .skip((page - 1) * limit)
        .limit(limit)
        .sort({ createdAt: -1 })
        .lean(),
      Monitor.countDocuments(filter),
    ]);

    const maskedMonitors = monitors.map(maskSensitiveFields);

    res.json({
      monitors: maskedMonitors,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
}

/** POST /api/monitors */
export async function createMonitor(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const data = monitorSchema.parse(req.body);
    const plan = req.userPlan || 'free';
    const limits = PLAN_LIMITS[plan];

    // Enforce interval minimum
    if (data.intervalSeconds < limits.minIntervalSeconds) {
      res.status(400).json({
        error: {
          code: 'PLAN_LIMIT',
          message: `Your plan requires a minimum interval of ${limits.minIntervalSeconds}s.`,
        },
      });
      return;
    }

    // Enforce monitor count
    const existingCount = await Monitor.countDocuments({ userId: req.userId });
    if (existingCount >= limits.maxMonitors) {
      res.status(403).json({
        error: {
          code: 'PLAN_LIMIT',
          message: `${plan === 'pro' ? 'Pro' : 'Free'} plan allows ${limits.maxMonitors} monitors. ${plan === 'free' ? 'Upgrade to Pro for 50 monitors.' : 'Delete an existing monitor to add another.'}`,
        },
      });
      return;
    }

    // Encrypt sensitive fields
    const encryptedHeaders = encryptHeaders(data.headers);
    const encryptedAuth = data.authCredentials ? encrypt(data.authCredentials) : '';

    const monitor = new Monitor({
      ...data,
      headers: encryptedHeaders,
      authCredentials: encryptedAuth,
      userId: req.userId,
      status: 'pending',
    });
    await monitor.save();

    // Schedule BullMQ job
    await schedulerService.scheduleMonitor(monitor);

    res.status(201).json({ monitor: maskSensitiveFields(monitor.toObject()) });
  } catch (err) {
    next(err);
  }
}

/** GET /api/monitors/:id */
export async function getMonitor(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const monitor = await Monitor.findOne({ _id: req.params.id, userId: req.userId }).lean();
    if (!monitor) {
      throw createError('Monitor not found', 404, 'NOT_FOUND');
    }
    res.json({ monitor: maskSensitiveFields(monitor) });
  } catch (err) {
    next(err);
  }
}

/** PUT /api/monitors/:id */
export async function updateMonitor(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const existing = await Monitor.findOne({ _id: req.params.id, userId: req.userId });
    if (!existing) {
      throw createError('Monitor not found', 404, 'NOT_FOUND');
    }

    const data = monitorSchema.parse(req.body);
    const plan = req.userPlan || 'free';
    const limits = PLAN_LIMITS[plan];

    if (data.intervalSeconds < limits.minIntervalSeconds) {
      res.status(400).json({
        error: {
          code: 'PLAN_LIMIT',
          message: `Your plan requires a minimum interval of ${limits.minIntervalSeconds}s.`,
        },
      });
      return;
    }

    // Process headers: keep existing encrypted value if sentinel is sent
    const processedHeaders = data.headers.map((h) => {
      if (h.value === SENTINEL) {
        // Find the existing encrypted value for this key
        const existing_h = existing.headers.find((eh) => eh.key === h.key);
        return { ...h, value: existing_h ? existing_h.value : '' };
      }
      return { ...h, value: h.value ? encrypt(h.value) : '' };
    });

    // Auth credentials: keep existing if sentinel
    let encryptedAuth = existing.authCredentials;
    if (data.authCredentials !== SENTINEL) {
      encryptedAuth = data.authCredentials ? encrypt(data.authCredentials) : '';
    }

    const intervalChanged = existing.intervalSeconds !== data.intervalSeconds;

    Object.assign(existing, {
      ...data,
      headers: processedHeaders,
      authCredentials: encryptedAuth,
    });
    await existing.save();

    // If interval changed, reschedule
    if (intervalChanged && existing.status !== 'paused') {
      await schedulerService.removeMonitorJob(existing._id.toString());
      await schedulerService.scheduleMonitor(existing);
    }

    res.json({ monitor: maskSensitiveFields(existing.toObject()) });
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/monitors/:id */
export async function deleteMonitor(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const monitor = await Monitor.findOne({ _id: req.params.id, userId: req.userId });
    if (!monitor) {
      throw createError('Monitor not found', 404, 'NOT_FOUND');
    }

    // Remove BullMQ job
    await schedulerService.removeMonitorJob(monitor._id.toString());

    // Delete related data
    await Promise.all([
      CheckResult.deleteMany({ monitorId: monitor._id }),
      Incident.deleteMany({ monitorId: monitor._id }),
      monitor.deleteOne(),
    ]);

    res.json({ message: 'Monitor deleted' });
  } catch (err) {
    next(err);
  }
}

/** POST /api/monitors/:id/pause */
export async function pauseMonitor(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const monitor = await Monitor.findOne({ _id: req.params.id, userId: req.userId });
    if (!monitor) {
      throw createError('Monitor not found', 404, 'NOT_FOUND');
    }
    if (monitor.status === 'paused') {
      res.json({ monitor: maskSensitiveFields(monitor.toObject()) });
      return;
    }

    await schedulerService.removeMonitorJob(monitor._id.toString());
    monitor.status = 'paused';
    await monitor.save();

    res.json({ monitor: maskSensitiveFields(monitor.toObject()) });
  } catch (err) {
    next(err);
  }
}

/** POST /api/monitors/:id/resume */
export async function resumeMonitor(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const monitor = await Monitor.findOne({ _id: req.params.id, userId: req.userId });
    if (!monitor) {
      throw createError('Monitor not found', 404, 'NOT_FOUND');
    }
    if (monitor.status !== 'paused') {
      res.json({ monitor: maskSensitiveFields(monitor.toObject()) });
      return;
    }

    const minimumInterval = req.userPlan === 'pro' ? PLAN_LIMITS.pro.minIntervalSeconds : PLAN_LIMITS.free.minIntervalSeconds;
    if (monitor.intervalSeconds < minimumInterval) monitor.intervalSeconds = minimumInterval;
    monitor.status = 'pending';
    await monitor.save();
    await schedulerService.scheduleMonitor(monitor);

    res.json({ monitor: maskSensitiveFields(monitor.toObject()) });
  } catch (err) {
    next(err);
  }
}

/** POST /api/monitors/test */
export async function testMonitor(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const data = testMonitorSchema.parse(req.body);

    // Build a temporary IMonitor-like object (not persisted)
    const fakeMonitor = {
      _id: new mongoose.Types.ObjectId(),
      userId: new mongoose.Types.ObjectId(req.userId),
      name: 'Test',
      url: data.url,
      method: data.method,
      headers: data.headers,
      body: data.body,
      bodyType: data.bodyType,
      authType: data.authType,
      authCredentials: data.authCredentials,
      intervalSeconds: 300,
      timeoutMs: data.timeoutMs,
      expectedStatusCodes: data.expectedStatusCodes,
      assertions: data.assertions || [],
      coldStartAware: false,
      keepAliveEnabled: false,
      failureThreshold: 1,
      status: 'pending' as const,
      lastCheckedAt: null,
      lastResponseTimeMs: null,
      currentIncidentId: null,
      showOnStatusPage: false,
      consecutiveFailures: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const outcome = await performCheck(fakeMonitor as any);

    res.json({ outcome });
  } catch (err) {
    next(err);
  }
}


/** POST /api/monitors/:id/check-now — run a health check immediately. */
export async function checkMonitorNow(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      throw createError('Invalid monitor id', 400, 'INVALID_ID');
    }

    const monitor = await Monitor.findOne({ _id: req.params.id, userId: req.userId });
    if (!monitor) throw createError('Monitor not found', 404, 'NOT_FOUND');
    if (monitor.status === 'paused') {
      throw createError('Resume this monitor before checking it', 409, 'MONITOR_PAUSED');
    }

    const outcome = await performCheck(monitor);
    const checkResult = await saveCheckResult(monitor, outcome);

    if (outcome.success || outcome.classification === 'cold_start' || outcome.classification === 'slow') {
      await handleSuccessfulCheck(monitor, checkResult);
    } else {
      await handleFailedCheck(monitor, checkResult);
    }

    const updatedMonitor = await Monitor.findOne({ _id: monitor._id, userId: req.userId }).lean();
    res.json({ outcome, check: checkResult, monitor: updatedMonitor });
  } catch (err) {
    next(err);
  }
}

/** GET /api/monitors/:id/checks */
export async function getChecks(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const monitor = await Monitor.findOne({ _id: req.params.id, userId: req.userId }).lean();
    if (!monitor) {
      throw createError('Monitor not found', 404, 'NOT_FOUND');
    }

    const page = Math.max(1, parseInt((req.query.page as string) || '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt((req.query.limit as string) || '50', 10)));

    const retentionDays = req.userPlan === 'pro' ? 30 : 7;
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const checksFilter = { monitorId: req.params.id, checkedAt: { $gte: cutoff } };
    const [checks, total] = await Promise.all([
      CheckResult.find(checksFilter)
        .sort({ checkedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      CheckResult.countDocuments(checksFilter),
    ]);

    res.json({
      checks,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
}

/** GET /api/monitors/:id/stats */
export async function getStats(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const monitor = await Monitor.findOne({ _id: req.params.id, userId: req.userId }).lean();
    if (!monitor) {
      throw createError('Monitor not found', 404, 'NOT_FOUND');
    }

    let range = (['24h', '7d', '30d'].includes(req.query.range as string)
      ? req.query.range
      : '24h') as '24h' | '7d' | '30d';
    const rangeLimited = req.userPlan !== 'pro' && range === '30d';
    if (rangeLimited) range = '7d';

    const includeColdStarts = req.query.includeColdStarts !== 'false';

    const stats = await computeStats(req.params.id, range, includeColdStarts);

    // Fill in incident stats
    const rangeMs = range === '24h' ? 86400000 : range === '7d' ? 604800000 : 2592000000;
    const since = new Date(Date.now() - rangeMs);

    const incidents = await Incident.find({
      monitorId: req.params.id,
      startedAt: { $gte: since },
    }).lean();

    stats.totalIncidentsInRange = incidents.length;
    stats.totalDowntimeSeconds = incidents.reduce((acc, inc) => {
      if (inc.durationSeconds) return acc + inc.durationSeconds;
      if (inc.status === 'open') {
        return acc + Math.round((Date.now() - inc.startedAt.getTime()) / 1000);
      }
      return acc;
    }, 0);

    res.json({ stats, range, rangeLimited, retentionDays: req.userPlan === 'pro' ? 30 : 7, monitor: { name: monitor.name, url: monitor.url, status: monitor.status } });
  } catch (err) {
    next(err);
  }
}

/** GET /api/monitors/:id/series */
export async function getSeries(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const monitor = await Monitor.findOne({ _id: req.params.id, userId: req.userId }).lean();
    if (!monitor) {
      throw createError('Monitor not found', 404, 'NOT_FOUND');
    }

    let range = (['24h', '7d', '30d'].includes(req.query.range as string)
      ? req.query.range
      : '24h') as '24h' | '7d' | '30d';
    const rangeLimited = req.userPlan !== 'pro' && range === '30d';
    if (rangeLimited) range = '7d';
    const series = await computeSeries(req.params.id, range);

    res.json({ series, range, rangeLimited, retentionDays: req.userPlan === 'pro' ? 30 : 7 });
  } catch (err) {
    next(err);
  }
}
