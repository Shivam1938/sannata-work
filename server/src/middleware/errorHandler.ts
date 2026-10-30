import type { Request, Response, NextFunction } from 'express';
import { logger } from '../config/logger.js';
import type { ZodError } from 'zod';

export interface AppError extends Error {
  statusCode?: number;
  code?: string;
}

export function errorHandler(
  err: AppError | ZodError,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  // Zod validation errors
  if ('issues' in err) {
    const zodErr = err as ZodError;
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: zodErr.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
    return;
  }

  const statusCode = err.statusCode || 500;
  const code = err.code || 'INTERNAL_ERROR';
  const message = statusCode === 500 ? 'An unexpected error occurred' : err.message;

  if (statusCode === 500) {
    logger.error({ err }, 'Unhandled server error');
  }

  res.status(statusCode).json({ error: { code, message } });
}

export function createError(message: string, statusCode: number, code: string): AppError {
  const err = new Error(message) as AppError;
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
}
