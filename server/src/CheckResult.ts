import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from './config/index.js';
import { User } from './models/User.js';
import { Monitor } from './models/Monitor.js';
import { schedulerService } from './queues/scheduler.js';

export interface AuthRequest extends Request {
  userId?: string;
  userPlan?: 'free' | 'pro';
}

/** Resolve the current plan from MongoDB, not the stale plan claim in the JWT. */
export async function authenticate(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const token = req.cookies?.token;
  if (!token) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    return;
  }

  let userId: string;
  try {
    const payload = jwt.verify(token, config.jwtSecret) as { userId: string };
    userId = payload.userId;
  } catch {
    res.status(401).json({ error: { code: 'INVALID_TOKEN', message: 'Invalid or expired token' } });
    return;
  }

  try {
    const user = await User.findById(userId).select('_id plan proExpiresAt subscriptionStartedAt');
    if (!user) {
      res.status(401).json({ error: { code: 'INVALID_TOKEN', message: 'Account no longer exists' } });
      return;
    }

    if (user.plan === 'pro' && !user.proExpiresAt) {
      const startedAt = user.subscriptionStartedAt || new Date();
      user.subscriptionStartedAt = startedAt;
      user.proExpiresAt = new Date(startedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
      await user.save();
    }

    if (user.plan === 'pro' && user.proExpiresAt && user.proExpiresAt.getTime() <= Date.now()) {
      user.plan = 'free';
      user.subscriptionStartedAt = null;
      user.proExpiresAt = null;
      await user.save();
      const monitors = await Monitor.find({ userId: user._id, intervalSeconds: { $lt: 300 } });
      for (const monitor of monitors) {
        monitor.intervalSeconds = 300;
        await monitor.save();
        if (monitor.status !== 'paused') {
          await schedulerService.removeMonitorJob(monitor._id.toString());
          await schedulerService.scheduleMonitor(monitor);
        }
      }
    }

    req.userId = user._id.toString();
    req.userPlan = user.plan;
    next();
  } catch (error) {
    next(error);
  }
}

export async function requirePlan(plan: 'pro') {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    const user = await User.findById(req.userId).select('plan proExpiresAt');
    if (!user || user.plan !== plan || (user.proExpiresAt && user.proExpiresAt.getTime() <= Date.now())) {
      res.status(403).json({ error: { code: 'PLAN_REQUIRED', message: `This feature requires the ${plan} plan` } });
      return;
    }
    req.userPlan = user.plan;
    next();
  };
}
