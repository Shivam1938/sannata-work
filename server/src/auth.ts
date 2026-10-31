import type { Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { User } from './models/User.js';
import { config } from './config/index.js';
import type { AuthRequest } from './middleware/auth.js';
import { createError } from './middleware/errorHandler.js';

const BCRYPT_ROUNDS = 12;
const TOKEN_EXPIRY = '7d';

const authCookieOptions = {
  httpOnly: true,
  secure: config.nodeEnv === 'production',
  sameSite: 'lax' as const,
  path: '/',
  ...(config.cookieDomain && config.cookieDomain !== 'localhost'
    ? { domain: config.cookieDomain }
    : {}),
};

function setTokenCookie(res: Response, userId: string, plan: string) {
  const token = jwt.sign({ userId, plan }, config.jwtSecret, { expiresIn: TOKEN_EXPIRY });
  res.cookie('token', token, { ...authCookieOptions, maxAge: 7 * 24 * 60 * 60 * 1000 });
  return token;
}

export const signupSchema = z.object({
  name: z.string().min(1).max(100).trim(),
  email: z.string().email().toLowerCase(),
  password: z.string().min(8).max(128),
});

export async function signup(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { name, email, password } = signupSchema.parse(req.body);

    const existing = await User.findOne({ email });
    if (existing) {
      throw createError('Email already in use', 409, 'EMAIL_EXISTS');
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = new User({ name, email, passwordHash });
    await user.save();

    setTokenCookie(res, user._id.toString(), user.plan);

    res.status(201).json({ user: { _id: user._id, name: user.name, email: user.email, plan: user.plan } });
  } catch (err) {
    next(err);
  }
}

export const loginSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(1),
});

export async function login(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { email, password } = loginSchema.parse(req.body);

    const user = await User.findOne({ email }).select('+passwordHash');
    if (!user) {
      throw createError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
    }

    const valid = await user.comparePassword(password);
    if (!valid) {
      throw createError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
    }

    setTokenCookie(res, user._id.toString(), user.plan);

    res.json({ user: { _id: user._id, name: user.name, email: user.email, plan: user.plan } });
  } catch (err) {
    next(err);
  }
}

export function logout(_req: AuthRequest, res: Response): void {
  // Cookie deletion must use the same path/domain/security attributes as creation.
  res.clearCookie('token', authCookieOptions);
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ success: true, message: 'Logged out' });
}

export async function me(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      throw createError('User not found', 404, 'NOT_FOUND');
    }
    res.json({ user: { id: user._id, name: user.name, email: user.email, plan: user.plan, subscriptionStartedAt: user.subscriptionStartedAt, proExpiresAt: user.proExpiresAt, alertEmail: user.alertEmail, alertPreferences: user.alertPreferences, telegramConnected: Boolean(user.telegramChatId), statusPageSlug: user.statusPageSlug, statusPageEnabled: user.statusPageEnabled, statusPageTitle: user.statusPageTitle, integrations: { telegramConfigured: Boolean(config.telegram.botToken && config.telegram.botUsername), emailConfigured: Boolean(config.smtp.host && config.smtp.user && config.smtp.pass), aiConfigured: Boolean(config.ai.apiKey) } } });
  } catch (err) {
    next(err);
  }
}
