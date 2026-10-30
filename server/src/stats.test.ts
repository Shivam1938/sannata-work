import type { ICheckResult } from '../models/CheckResult.js';
import { CheckResult } from '../models/CheckResult.js';

export interface StatsResult {
  uptimePercent: number;
  avgResponseTimeMs: number | null;
  p50ResponseTimeMs: number | null;
  p95ResponseTimeMs: number | null;
  p99ResponseTimeMs: number | null;
  totalChecks: number;
  upChecks: number;
  downChecks: number;
  errorRate: number;
  statusCodeDistribution: Record<string, number>;
  totalIncidentsInRange: number;
  totalDowntimeSeconds: number;
  coldStartCount: number;
}

export interface SeriesPoint {
  timestamp: Date;
  avgResponseTimeMs: number | null;
  upCount: number;
  downCount: number;
  coldStartCount: number;
}

/**
 * Compute the nearest-rank percentile from a sorted array of numbers.
 * arr must be sorted ascending.
 */
export function percentile(sortedArr: number[], p: number): number | null {
  if (sortedArr.length === 0) return null;
  if (p <= 0) return sortedArr[0];
  if (p >= 100) return sortedArr[sortedArr.length - 1];
  const rank = Math.ceil((p / 100) * sortedArr.length);
  return sortedArr[rank - 1];
}

/**
 * Compute uptime percentage given an array of checks.
 * up = success (ok, slow, cold_start), down = failed.
 */
export function computeUptime(checks: Pick<ICheckResult, 'success' | 'classification'>[]): number {
  if (checks.length === 0) return 100;
  const upCount = checks.filter((c) => c.success).length;
  return Math.round((upCount / checks.length) * 10000) / 100;
}

type RangeKey = '24h' | '7d' | '30d';

function getRangeMs(range: RangeKey): number {
  const map: Record<RangeKey, number> = {
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
  };
  return map[range];
}

function getBucketMs(range: RangeKey): number {
  // 24h → 5 min buckets, 7d → 1h buckets, 30d → 6h buckets
  const map: Record<RangeKey, number> = {
    '24h': 5 * 60 * 1000,
    '7d': 60 * 60 * 1000,
    '30d': 6 * 60 * 60 * 1000,
  };
  return map[range];
}

/**
 * Compute full stats for a monitor over a time range.
 */
export async function computeStats(
  monitorId: string,
  range: RangeKey,
  includeColdStarts: boolean
): Promise<StatsResult> {
  const since = new Date(Date.now() - getRangeMs(range));

  const checks = await CheckResult.find({ monitorId, checkedAt: { $gte: since } })
    .sort({ checkedAt: 1 })
    .lean();

  const totalChecks = checks.length;
  const upChecks = checks.filter((c) => c.success).length;
  const downChecks = totalChecks - upChecks;
  const coldStartCount = checks.filter((c) => c.classification === 'cold_start').length;

  const uptimePercent = computeUptime(checks);
  const errorRate = totalChecks > 0 ? Math.round((downChecks / totalChecks) * 10000) / 100 : 0;

  // Response times for successful checks
  const successChecks = checks.filter((c) => {
    if (!c.success || c.responseTimeMs === null) return false;
    if (!includeColdStarts && c.classification === 'cold_start') return false;
    return true;
  });

  const responseTimes = successChecks
    .map((c) => c.responseTimeMs as number)
    .sort((a, b) => a - b);

  const avgResponseTimeMs =
    responseTimes.length > 0
      ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length)
      : null;

  const p50 = percentile(responseTimes, 50);
  const p95 = percentile(responseTimes, 95);
  const p99 = percentile(responseTimes, 99);

  // Status code distribution
  const statusCodeDistribution: Record<string, number> = {};
  for (const c of checks) {
    if (c.statusCode !== null) {
      const key = String(c.statusCode);
      statusCodeDistribution[key] = (statusCodeDistribution[key] || 0) + 1;
    }
  }

  return {
    uptimePercent,
    avgResponseTimeMs,
    p50ResponseTimeMs: p50,
    p95ResponseTimeMs: p95,
    p99ResponseTimeMs: p99,
    totalChecks,
    upChecks,
    downChecks,
    errorRate,
    statusCodeDistribution,
    totalIncidentsInRange: 0, // filled in by the controller
    totalDowntimeSeconds: 0,  // filled in by the controller
    coldStartCount,
  };
}

/**
 * Compute time-bucketed series for charts.
 */
export async function computeSeries(
  monitorId: string,
  range: RangeKey
): Promise<SeriesPoint[]> {
  const rangeMs = getRangeMs(range);
  const bucketMs = getBucketMs(range);
  const now = Date.now();
  const since = new Date(now - rangeMs);

  const checks = await CheckResult.find({ monitorId, checkedAt: { $gte: since } })
    .sort({ checkedAt: 1 })
    .lean();

  const buckets = new Map<number, { responseTimes: number[]; upCount: number; downCount: number; coldStartCount: number }>();

  for (const c of checks) {
    const ts = c.checkedAt.getTime();
    const bucketTs = Math.floor(ts / bucketMs) * bucketMs;
    if (!buckets.has(bucketTs)) {
      buckets.set(bucketTs, { responseTimes: [], upCount: 0, downCount: 0, coldStartCount: 0 });
    }
    const bucket = buckets.get(bucketTs)!;
    if (c.success) {
      bucket.upCount++;
      if (c.responseTimeMs !== null) bucket.responseTimes.push(c.responseTimeMs);
      if (c.classification === 'cold_start') bucket.coldStartCount++;
    } else {
      bucket.downCount++;
    }
  }

  const series: SeriesPoint[] = [];
  let bucketStart = Math.floor(since.getTime() / bucketMs) * bucketMs;
  const end = Math.floor(now / bucketMs) * bucketMs;

  while (bucketStart <= end) {
    const bucket = buckets.get(bucketStart);
    const avgRT =
      bucket && bucket.responseTimes.length > 0
        ? Math.round(bucket.responseTimes.reduce((a, b) => a + b, 0) / bucket.responseTimes.length)
        : null;
    series.push({
      timestamp: new Date(bucketStart),
      avgResponseTimeMs: avgRT,
      upCount: bucket?.upCount || 0,
      downCount: bucket?.downCount || 0,
      coldStartCount: bucket?.coldStartCount || 0,
    });
    bucketStart += bucketMs;
  }

  return series;
}
