import Anthropic from '@anthropic-ai/sdk';
import { config } from './config/index.js';
import { logger } from './config/logger.js';
import type { IMonitor } from './models/Monitor.js';
import type { IIncident } from './models/Incident.js';
import type { ICheckResult } from './models/CheckResult.js';
import type { ErrorType } from './models/CheckResult.js';

let anthropicClient: Anthropic | null = null;

function getClient(): Anthropic | null {
  if (!config.ai.apiKey) return null;
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: config.ai.apiKey });
  }
  return anthropicClient;
}

/**
 * Rule-based summary for free users or when AI is unavailable.
 */
export function generateRuleBasedSummary(
  type: 'open' | 'resolved',
  errorType: ErrorType | null | string,
  _errorMessage: string | null
): string {
  if (type === 'resolved') {
    return 'The monitor has recovered and is now responding normally.';
  }

  switch (errorType) {
    case 'timeout':
      return 'Server did not respond within the timeout limit. It may be asleep (cold start on a free tier) or experiencing high load. Check your hosting dashboard and try visiting the URL manually.';
    case 'dns':
      return 'The domain could not be resolved. This may indicate a DNS misconfiguration or expired domain. Verify your domain settings and DNS records.';
    case 'connection_refused':
      return 'The server actively refused the connection. The service may have crashed or the port may be wrong. Check that your server process is running.';
    case 'tls':
      return 'An SSL/TLS error occurred. Your certificate may be expired or misconfigured. Check your SSL certificate validity.';
    case 'bad_status':
      return 'Server is reachable but returning unexpected status codes. This usually indicates a server-side error (5xx) or misconfigured expected status. Check your server logs.';
    case 'assertion_failed':
      return 'The server responded successfully but the response did not match the configured assertions. The API contract may have changed.';
    case 'ssrf':
      return 'The target URL is not allowed by the SSRF safety policy.';
    default:
      return 'An unexpected error occurred. Check your server logs and verify the URL is correct and accessible.';
  }
}

/**
 * AI-powered incident summary using Anthropic Claude.
 * Falls back to rule-based summary on any error.
 */
export async function generateAiSummary(
  type: 'open' | 'resolved',
  monitor: IMonitor,
  incident: IIncident,
  recentChecks: Pick<ICheckResult, 'statusCode' | 'responseTimeMs' | 'errorType' | 'attempts' | 'checkedAt'>[]
): Promise<string | null> {
  const client = getClient();
  if (!client) {
    return generateRuleBasedSummary(type, incident.firstErrorType, incident.lastErrorMessage);
  }

  try {
    const monitorContext = {
      name: monitor.name,
      url: monitor.url,
      method: monitor.method,
      expectedStatusCodes: monitor.expectedStatusCodes,
    };

    const checksContext = recentChecks.map((c) => ({
      checkedAt: c.checkedAt,
      statusCode: c.statusCode,
      responseTimeMs: c.responseTimeMs,
      errorType: c.errorType,
      attempts: c.attempts,
    }));

    const incidentContext = {
      startedAt: incident.startedAt,
      resolvedAt: incident.resolvedAt,
      durationSeconds: incident.durationSeconds,
      firstErrorType: incident.firstErrorType,
      failedChecksCount: incident.failedChecksCount,
      lastErrorMessage: incident.lastErrorMessage,
    };

    const prompt =
      type === 'open'
        ? `You are analyzing an API monitoring incident. Based on the data below, provide at most 3 short sentences in plain English explaining the likely cause and one concrete next step to check. Do not invent facts not present in the data. If the evidence is weak or unclear, say "unclear". Be concise.

Monitor: ${JSON.stringify(monitorContext)}
Recent checks: ${JSON.stringify(checksContext)}
Incident: ${JSON.stringify(incidentContext)}`
        : `You are summarizing a resolved API monitoring incident. Based on the data below, write 1-2 sentences describing the incident duration and probable cause. Be concise and factual.

Monitor: ${JSON.stringify(monitorContext)}
Incident: ${JSON.stringify(incidentContext)}`;

    const response = await client.messages.create({
      model: config.ai.model,
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text.trim() : null;
    return text;
  } catch (err) {
    logger.error({ err }, 'AI summary generation failed, falling back to rule-based');
    return generateRuleBasedSummary(type, incident.firstErrorType, incident.lastErrorMessage);
  }
}
