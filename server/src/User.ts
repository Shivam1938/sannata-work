import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

/** Validate req.body against a Zod schema */
export function validate<T>(schema: z.ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Validation failed',
          details: result.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        },
      });
      return;
    }
    req.body = result.data;
    next();
  };
}
