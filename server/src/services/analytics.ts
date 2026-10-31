import mongoose from 'mongoose';
import { CheckResult } from '../models/CheckResult.js';
import { Monitor } from '../models/Monitor.js';

type AnalyticsRange = '24h' | '7d' | '30d';

export async function getMonitoringAnalytics(userId: string, range: AnalyticsRange) {
  const rangeMs = range === '24h' ? 86400000 : range === '7d' ? 7 * 86400000 : 30 * 86400000;
  const bucketCount = range === '24h' ? 24 : range === '7d' ? 7 : 30;
  const bucketMs = rangeMs / bucketCount;
  const since = new Date(Date.now() - rangeMs);
  const ownerId = new mongoose.Types.ObjectId(userId);
  const match = { userId: ownerId, checkedAt: { $gte: since } };
  const aggregateCheckResults = (pipeline: Record<string, unknown>[]) =>
    CheckResult.collection.aggregate(pipeline).toArray();

  const [monitors, summaryRows, bucketRows, statusRows, endpointRows, errorGroupRows, errorRows] = await Promise.all([
    Monitor.find({ userId: ownerId })
      .select('_id name url method status intervalSeconds lastCheckedAt lastResponseTimeMs')
      .lean(),
    aggregateCheckResults([
      { $match: match },
      {
        $project: {
          success: 1,
          latencySample: {
            $cond: [
              { $and: [{ $eq: ['$success', true] }, { $ne: ['$classification', 'cold_start'] }, { $isNumber: '$responseTimeMs' }] },
              '$responseTimeMs',
              null,
            ],
          },
        },
      },
      {
        $group: {
          _id: null,
          totalChecks: { $sum: 1 },
          successfulChecks: { $sum: { $cond: ['$success', 1, 0] } },
          failedChecks: { $sum: { $cond: ['$success', 0, 1] } },
          latencySamples: { $sum: { $cond: [{ $isNumber: '$latencySample' }, 1, 0] } },
          latencySum: { $sum: { $cond: [{ $isNumber: '$latencySample' }, '$latencySample', 0] } },
          maxLatencyMs: { $max: '$latencySample' },
          percentiles: {
            $percentile: { input: '$latencySample', p: [0.5, 0.95, 0.99], method: 'approximate' },
          },
        },
      },
    ]),
    aggregateCheckResults([
      { $match: match },
      {
        $project: {
          success: 1,
          responseTimeMs: 1,
          classification: 1,
          bucket: { $floor: { $divide: [{ $subtract: ['$checkedAt', since] }, bucketMs] } },
        },
      },
      {
        $group: {
          _id: '$bucket',
          total: { $sum: 1 },
          successful: { $sum: { $cond: ['$success', 1, 0] } },
          failed: { $sum: { $cond: ['$success', 0, 1] } },
          latencyCount: {
            $sum: {
              $cond: [
                { $and: ['$success', { $ne: ['$classification', 'cold_start'] }, { $isNumber: '$responseTimeMs' }] },
                1,
                0,
              ],
            },
          },
          latencySum: {
            $sum: {
              $cond: [
                { $and: ['$success', { $ne: ['$classification', 'cold_start'] }, { $isNumber: '$responseTimeMs' }] },
                '$responseTimeMs',
                0,
              ],
            },
          },
        },
      },
    ]),
    aggregateCheckResults([
      { $match: match },
      {
        $project: {
          statusGroup: {
            $switch: {
              branches: [
                { case: { $eq: ['$statusCode', null] }, then: 'No response' },
                { case: { $lt: ['$statusCode', 200] }, then: '1xx Informational' },
                { case: { $lt: ['$statusCode', 300] }, then: '2xx Success' },
                { case: { $lt: ['$statusCode', 400] }, then: '3xx Redirect' },
                { case: { $lt: ['$statusCode', 500] }, then: '4xx Client error' },
              ],
              default: '5xx Server error',
            },
          },
        },
      },
      { $group: { _id: '$statusGroup', value: { $sum: 1 } } },
    ]),
    aggregateCheckResults([
      { $match: match },
      {
        $project: {
          monitorId: 1,
          success: 1,
          classification: 1,
          responseTimeMs: 1,
          latencySample: {
            $cond: [
              { $and: [{ $eq: ['$success', true] }, { $ne: ['$classification', 'cold_start'] }, { $isNumber: '$responseTimeMs' }] },
              '$responseTimeMs',
              null,
            ],
          },
        },
      },
      {
        $group: {
          _id: '$monitorId',
          hits: { $sum: 1 },
          failed: { $sum: { $cond: ['$success', 0, 1] } },
          latencySamples: { $sum: { $cond: [{ $isNumber: '$latencySample' }, 1, 0] } },
          latencySum: { $sum: { $cond: [{ $isNumber: '$latencySample' }, '$latencySample', 0] } },
          p95Values: {
            $percentile: { input: '$latencySample', p: [0.95], method: 'approximate' },
          },
        },
      },
    ]),
    aggregateCheckResults([
      { $match: { ...match, success: false } },
      { $sort: { checkedAt: 1 } },
      {
        $group: {
          _id: { monitorId: '$monitorId', errorType: '$errorType', statusCode: '$statusCode' },
          count: { $sum: 1 },
          firstOccurrence: { $first: '$checkedAt' },
          lastOccurrence: { $last: '$checkedAt' },
          lastMessage: { $last: '$errorMessage' },
        },
      },
      { $sort: { lastOccurrence: -1 } },
    ]),
    aggregateCheckResults([
      { $match: { ...match, success: false } },
      { $sort: { checkedAt: -1 } },
      { $limit: 100 },
      {
        $project: {
          monitorId: 1,
          statusCode: 1,
          errorType: 1,
          message: '$errorMessage',
          responseTimeMs: 1,
          checkedAt: 1,
          attempts: 1,
        },
      },
    ]),
  ]);

  const monitorById = new Map(monitors.map((monitor) => [String(monitor._id), monitor]));
  const summary = summaryRows[0] ?? {
    totalChecks: 0,
    successfulChecks: 0,
    failedChecks: 0,
    latencySamples: 0,
    latencySum: 0,
    maxLatencyMs: null,
    percentiles: [],
  };
  const percentiles = summary.percentiles as number[];
  const traffic = Array.from({ length: bucketCount }, (_, index) => {
    const bucket = bucketRows.find((row) => row._id === index);
    const start = new Date(since.getTime() + index * bucketMs);
    return {
      label: range === '24h'
        ? start.toLocaleTimeString([], { hour: 'numeric' })
        : start.toLocaleDateString([], { month: 'short', day: 'numeric' }),
      total: bucket?.total ?? 0,
      success: bucket?.successful ?? 0,
      failed: bucket?.failed ?? 0,
      avgLatencyMs: bucket?.latencyCount ? Math.round(bucket.latencySum / bucket.latencyCount) : null,
    };
  });
  const endpointStats = new Map(endpointRows.map((row) => [String(row._id), row]));
  const topEndpoints = monitors.map((monitor) => {
    const row = endpointStats.get(String(monitor._id));
    let hostname: string | null = null;
    try { hostname = new URL(monitor.url).hostname; } catch { hostname = null; }
    return {
      monitorId: String(monitor._id),
      name: monitor.name,
      url: monitor.url,
      method: monitor.method,
      hostname,
      hits: row?.hits ?? 0,
      avgLatencyMs: row?.latencySamples ? Math.round(row.latencySum / row.latencySamples) : null,
      p95LatencyMs: row && row.latencySamples >= 20 ? row.p95Values?.[0] ?? null : null,
      errorRate: row?.hits ? Number((row.failed / row.hits * 100).toFixed(1)) : null,
      status: monitor.status,
      intervalSeconds: monitor.intervalSeconds,
      lastCheckedAt: monitor.lastCheckedAt,
      lastResponseTimeMs: monitor.lastResponseTimeMs,
    };
  }).sort((a, b) => b.hits - a.hits);

  const errorGroups = errorGroupRows.map((row) => {
    const monitorId = String(row._id.monitorId);
    const monitor = monitorById.get(monitorId);
    const statusCode = row._id.statusCode as number | null;
    const errorType = row._id.errorType as string | null;
    return {
      monitorId,
      monitorName: monitor?.name || 'Deleted monitor',
      url: monitor?.url || '',
      category: errorType || (statusCode ? `HTTP ${Math.floor(statusCode / 100)}xx` : 'No response'),
      errorType,
      statusCode,
      count: row.count,
      firstOccurrence: row.firstOccurrence,
      lastOccurrence: row.lastOccurrence,
      lastMessage: row.lastMessage,
    };
  });
  const errors = errorRows.map((row) => {
    const monitorId = String(row.monitorId);
    const monitor = monitorById.get(monitorId);
    return {
      monitorId,
      monitorName: monitor?.name || 'Deleted monitor',
      url: monitor?.url || '',
      statusCode: row.statusCode,
      errorType: row.errorType,
      message: row.message,
      responseTimeMs: row.responseTimeMs,
      checkedAt: row.checkedAt,
      attempts: row.attempts,
    };
  });
  const hostnames = new Set(topEndpoints.map((endpoint) => endpoint.hostname).filter(Boolean));
  const statusDistribution = statusRows.map(({ _id, value }) => ({ name: _id, value }));
  const latencySamples = summary.latencySamples as number;

  return {
    range,
    summary: {
      totalChecks: summary.totalChecks as number,
      avgResponseTimeMs: latencySamples ? Math.round((summary.latencySum as number) / latencySamples) : null,
      errorRate: summary.totalChecks ? Number(((summary.failedChecks as number) / (summary.totalChecks as number) * 100).toFixed(1)) : null,
      successRate: summary.totalChecks ? Number(((summary.successfulChecks as number) / (summary.totalChecks as number) * 100).toFixed(1)) : null,
      failedChecks: summary.failedChecks as number,
      uniqueServices: hostnames.size,
      uniqueEndpoints: monitors.length,
      p50ResponseTimeMs: latencySamples ? percentiles?.[0] ?? null : null,
      p95ResponseTimeMs: latencySamples >= 20 ? percentiles?.[1] ?? null : null,
      p99ResponseTimeMs: latencySamples >= 100 ? percentiles?.[2] ?? null : null,
      latencySamples,
      percentileMethod: 'approximate',
      maxResponseTimeMs: summary.maxLatencyMs ?? null,
    },
    traffic,
    statusDistribution,
    topEndpoints,
    errorGroups,
    errors,
  };
}
