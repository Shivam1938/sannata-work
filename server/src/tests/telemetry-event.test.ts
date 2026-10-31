import { describe, expect, it } from 'vitest';
import { telemetryEventSchema } from '../controllers/telemetry.controller.js';

describe('incoming request event validation', () => {
  const validEvent = {
    service: 'billing-api',
    method: 'GET',
    path: '/v1/invoices',
    statusCode: 200,
    latencyMs: 42,
    timestamp: '2026-10-31T00:00:00.000Z',
  };

  it('accepts a bounded request event without query parameters', () => {
    expect(telemetryEventSchema.parse(validEvent)).toMatchObject(validEvent);
  });

  it('rejects event paths containing query strings or invalid measurements', () => {
    expect(telemetryEventSchema.safeParse({ ...validEvent, path: '/v1/invoices?token=secret' }).success).toBe(false);
    expect(telemetryEventSchema.safeParse({ ...validEvent, statusCode: 99 }).success).toBe(false);
    expect(telemetryEventSchema.safeParse({ ...validEvent, latencyMs: -1 }).success).toBe(false);
  });
});
