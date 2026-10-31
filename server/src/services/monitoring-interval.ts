export const MIN_FREE_INTERVAL_SECONDS = 300;
export const MIN_PRO_INTERVAL_SECONDS = 60;
export const MAX_MONITOR_INTERVAL_SECONDS = 24 * 60 * 60;
export const FREE_INTERVAL_PRESETS = [300, 600, 1800, 3600] as const;

export function isValidMonitorInterval(intervalSeconds: number, plan: 'free' | 'pro'): boolean {
  if (!Number.isInteger(intervalSeconds)) return false;
  if (plan === 'free') return FREE_INTERVAL_PRESETS.includes(intervalSeconds as (typeof FREE_INTERVAL_PRESETS)[number]);
  return intervalSeconds >= MIN_PRO_INTERVAL_SECONDS && intervalSeconds <= MAX_MONITOR_INTERVAL_SECONDS;
}

export function minimumMonitorInterval(plan: 'free' | 'pro'): number {
  return plan === 'pro' ? MIN_PRO_INTERVAL_SECONDS : MIN_FREE_INTERVAL_SECONDS;
}

export function isScheduledCheckDue(
  lastCheckedAt: Date | null | undefined,
  intervalSeconds: number,
  nowMs = Date.now(),
): boolean {
  return !lastCheckedAt || nowMs >= lastCheckedAt.getTime() + intervalSeconds * 1000;
}
