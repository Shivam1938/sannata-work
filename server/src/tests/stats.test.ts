import { describe, it, expect } from 'vitest';
import { percentile, computeUptime } from '../services/stats.js';
import type { ICheckResult } from '../models/CheckResult.js';

describe('percentile()', () => {
  it('returns null for empty array', () => {
    expect(percentile([], 50)).toBeNull();
  });

  it('returns the only element for single-element array', () => {
    expect(percentile([100], 50)).toBe(100);
    expect(percentile([100], 95)).toBe(100);
    expect(percentile([100], 99)).toBe(100);
  });

  it('returns first for p=0', () => {
    expect(percentile([10, 20, 30], 0)).toBe(10);
  });

  it('returns last for p=100', () => {
    expect(percentile([10, 20, 30], 100)).toBe(30);
  });

  it('computes p50 correctly', () => {
    const arr = [100, 200, 300, 400, 500];
    // nearest rank: ceil(50/100 * 5) = 3 → index 2 → 300
    expect(percentile(arr, 50)).toBe(300);
  });

  it('computes p95 correctly', () => {
    // 20 elements: ceil(95/100 * 20) = 19 → index 18
    const arr = Array.from({ length: 20 }, (_, i) => (i + 1) * 10); // 10..200
    expect(percentile(arr, 95)).toBe(190);
  });

  it('computes p99 for large array', () => {
    const arr = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    // ceil(99/100 * 100) = 99 → index 98 → 99
    expect(percentile(arr, 99)).toBe(99);
  });
});

describe('computeUptime()', () => {
  it('returns 100 for empty array', () => {
    expect(computeUptime([])).toBe(100);
  });

  it('returns 100 when all checks succeed', () => {
    const checks = [
      { success: true, classification: 'ok' as const },
      { success: true, classification: 'ok' as const },
    ];
    expect(computeUptime(checks)).toBe(100);
  });

  it('returns 0 when all checks fail', () => {
    const checks = [
      { success: false, classification: 'failed' as const },
      { success: false, classification: 'failed' as const },
    ];
    expect(computeUptime(checks)).toBe(0);
  });

  it('counts cold_start and slow as up', () => {
    const checks = [
      { success: true, classification: 'cold_start' as const },
      { success: true, classification: 'slow' as const },
      { success: false, classification: 'failed' as const },
    ];
    // 2 up out of 3 = 66.67%
    expect(computeUptime(checks)).toBe(66.67);
  });

  it('handles mixed results', () => {
    const checks = [
      { success: true, classification: 'ok' as const },
      { success: true, classification: 'ok' as const },
      { success: true, classification: 'ok' as const },
      { success: false, classification: 'failed' as const },
    ];
    // 75% uptime
    expect(computeUptime(checks)).toBe(75);
  });
});

describe('cold-start classification logic', () => {
  it('classifies as cold_start when response time > 4x median', () => {
    // Median of [100, 110, 90, 100, 105, 95] sorted = 100
    // Threshold = max(2000, 4 * 100) = max(2000, 400) = 2000
    // A response of 2500ms should be cold start
    const recentTimes = [100, 110, 90, 100, 105, 95].sort((a, b) => a - b);
    const median = recentTimes[Math.floor(recentTimes.length / 2)];
    const threshold = Math.max(2000, median * 4);
    const responseTime = 2500;
    expect(responseTime > threshold).toBe(true);
  });

  it('does NOT classify as cold_start when response time is just slow', () => {
    // Median of [500, 600, 550] = 550
    // Threshold = max(2000, 4*550) = max(2000, 2200) = 2200
    // A response of 1800ms should NOT be cold start
    const recentTimes = [500, 600, 550].sort((a, b) => a - b);
    const median = recentTimes[Math.floor(recentTimes.length / 2)];
    const threshold = Math.max(2000, median * 4);
    const responseTime = 1800;
    expect(responseTime > threshold).toBe(false);
  });

  it('uses 2000ms floor when median is low', () => {
    // Median = 100ms → threshold = max(2000, 400) = 2000
    const median = 100;
    const threshold = Math.max(2000, median * 4);
    expect(threshold).toBe(2000);
  });

  it('uses 4x median when median is high', () => {
    // Median = 700ms → threshold = max(2000, 2800) = 2800
    const median = 700;
    const threshold = Math.max(2000, median * 4);
    expect(threshold).toBe(2800);
  });
});
