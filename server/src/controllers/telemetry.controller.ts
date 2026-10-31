import { createHash, randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { User } from '../models/User.js';
import { TelemetryEvent, type ITelemetryEvent } from '../models/TelemetryEvent.js';
import { createError } from '../middleware/errorHandler.js';
import type { AuthRequest } from '../middleware/auth.js';

const clientsByUser = new Map<string, Set<Response>>();
const keyHash = (key: string) => createHash('sha256').update(key).digest('hex');
export const telemetryEventSchema = z.object({
  service: z.string().trim().min(1).max(100),
  method: z.string().trim().min(1).max(10).regex(/^[A-Za-z]+$/),
  path: z.string().trim().min(1).max(500).refine((value) => value.startsWith('/') && !value.includes('?')),
  statusCode: z.number().int().min(100).max(599),
  latencyMs: z.number().finite().min(0).max(600000),
  timestamp: z.string().datetime().optional(),
  correlationId: z.string().trim().max(128).optional(),
  error: z.object({
    type: z.string().trim().max(100).optional(),
    message: z.string().trim().max(500).optional(),
  }).optional(),
});

function redactErrorMessage(message: string | undefined) {
  if (!message) return null;
  return message
    .replace(/\b(?:bearer|basic)\s+[^\s,;]+/gi, '[REDACTED]')
    .replace(/\b(password|passwd|secret|token|api[_-]?key|authorization)\b(\s*[:=]\s*|\s+)[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 500);
}

export async function getTelemetryKeyStatus(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const user = await User.findById(req.userId).select('+telemetryKeyHash');
    if (!user) throw createError('User not found', 404, 'NOT_FOUND');
    res.json({ configured: Boolean(user.telemetryKeyHash) });
  } catch (error) {
    next(error);
  }
}

export async function createTelemetryKey(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const key = `sannata_${randomBytes(32).toString('base64url')}`;
    const user = await User.findByIdAndUpdate(
      req.userId,
      { $set: { telemetryKeyHash: keyHash(key) } },
      { new: true },
    ).select('_id');
    if (!user) throw createError('User not found', 404, 'NOT_FOUND');
    res.status(201).json({ key });
  } catch (error) {
    next(error);
  }
}

export async function revokeTelemetryKey(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    await User.findByIdAndUpdate(req.userId, { $set: { telemetryKeyHash: null } });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
}

export async function ingestTelemetryEvent(req: Request, res: Response, next: NextFunction) {
  try {
    const key = req.header('x-sannata-key');
    if (!key || key.length > 128) throw createError('A valid ingestion key is required.', 401, 'INVALID_INGESTION_KEY');
    const user = await User.findOne({ telemetryKeyHash: keyHash(key) }).select('_id');
    if (!user) throw createError('A valid ingestion key is required.', 401, 'INVALID_INGESTION_KEY');
    const data = telemetryEventSchema.parse(req.body);
    const event = await TelemetryEvent.create({
      userId: user._id,
      service: data.service,
      method: data.method.toUpperCase(),
      path: data.path,
      statusCode: data.statusCode,
      latencyMs: Math.round(data.latencyMs),
      occurredAt: data.timestamp ? new Date(data.timestamp) : new Date(),
      correlationId: data.correlationId || null,
      errorType: data.error?.type || null,
      errorMessage: redactErrorMessage(data.error?.message),
    });
    publishEvent(String(user._id), event);
    res.status(202).json({ accepted: true });
  } catch (error) {
    next(error);
  }
}

export async function listTelemetryEvents(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const events = await TelemetryEvent.find({ userId: req.userId })
      .sort({ occurredAt: -1 })
      .limit(limit)
      .lean();
    res.json({ events });
  } catch (error) {
    next(error);
  }
}

export async function streamTelemetryEvents(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.userId!;
    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 5000\n\n');

    const clients = clientsByUser.get(userId) || new Set<Response>();
    clients.add(res);
    clientsByUser.set(userId, clients);
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 25000);

    res.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
      if (clients.size === 0) clientsByUser.delete(userId);
    });
  } catch (error) {
    next(error);
  }
}

function publishEvent(userId: string, event: ITelemetryEvent) {
  const clients = clientsByUser.get(userId);
  if (!clients) return;
  const payload = JSON.stringify(event.toObject());
  for (const client of clients) client.write(`event: request\ndata: ${payload}\n\n`);
}
