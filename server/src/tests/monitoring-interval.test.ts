import { describe, expect, it } from 'vitest';
import {
  FREE_INTERVAL_PRESETS,
  MAX_MONITOR_INTERVAL_SECONDS,
  isScheduledCheckDue,
  isValidMonitorInterval,
} from '../services/monitoring-interval.js';

describe('monitor interval entitlements', () => {
  it('accepts only configured Free presets', () => {
    for (const interval of FREE_INTERVAL_PRESETS) {
      expect(isValidMonitorInterval(interval, 'free')).toBe(true);
    }
    expect(isValidMonitorInterval(60, 'free')).toBe(false);
    expect(isValidMonitorInterval(301, 'free')).toBe(false);
  });

  it('allows bounded Pro custom intervals in seconds', () => {
    expect(isValidMonitorInterval(60, 'pro')).toBe(true);
    expect(isValidMonitorInterval(301, 'pro')).toBe(true);
    expect(isValidMonitorInterval(MAX_MONITOR_INTERVAL_SECONDS, 'pro')).toBe(true);
    expect(isValidMonitorInterval(59, 'pro')).toBe(false);
    expect(isValidMonitorInterval(MAX_MONITOR_INTERVAL_SECONDS + 1, 'pro')).toBe(false);
    expect(isValidMonitorInterval(60.5, 'pro')).toBe(false);
  });

  it('does not run a scheduled check before the configured interval elapses', () => {
    const lastCheckedAt = new Date(10_000);
    expect(isScheduledCheckDue(lastCheckedAt, 90, 99_999)).toBe(false);
    expect(isScheduledCheckDue(lastCheckedAt, 90, 100_000)).toBe(true);
    expect(isScheduledCheckDue(null, 90, 10_000)).toBe(true);
  });
});
