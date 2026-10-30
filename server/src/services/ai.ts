import { config } from '../config/index.js';
import { logger } from '../config/logger.js';
import type { IMonitor } from '../models/Monitor.js';
import type { IIncident } from '../models/Incident.js';
import type { ICheckResult } from '../models/CheckResult.js';
import type { ErrorType } from '../models/CheckResult.js';

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
 * AI-powered incident summary using Groq.
 * Falls back to rule-based summary on any error.
 */
export async function generateAiSummary(
  type: 'open' | 'resolved',
  monitor: IMonitor,
  incident: IIncident,
  recentChecks: Pick<ICheckResult, 'statusCode' | 'responseTimeMs' | 'errorType' | 'attempts' | 'checkedAt'>[]
): Promise<string | null> {
  if (!config.ai.apiKey) {
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
        ? `Prepare a practical incident diagnosis for a developer. Use ONLY the monitor and check evidence below. Do not claim to have inspected source code, logs, infrastructure, or dependencies unless the evidence explicitly contains that information. Separate facts from hypotheses. If evidence is insufficient, say so. Never invent commands, file names, stack traces, or configuration values.

Return the answer using exactly these sections and keep it useful, not verbose:
DIAGNOSIS: one or two sentences explaining what failed and the most likely interpretation.
EVIDENCE: 2-4 short bullets with observed facts (status codes, error type/message, latency, repeated failures).
LIKELY CAUSES: 2-3 ranked possibilities, each marked Likely/Possible and briefly explaining why.
RECOMMENDED FIX: 2-4 numbered, safe steps the developer should check or change. Make each step concrete; do not recommend destructive actions.
VERIFY THE FIX: 1-2 steps to confirm recovery (for example, retry the endpoint and confirm expected status codes).
CONFIDENCE: High, Medium, or Low, with one short reason.

Monitor: ${JSON.stringify(monitorContext)}
Recent checks (newest first): ${JSON.stringify(checksContext)}
Incident: ${JSON.stringify(incidentContext)}`
        : `Write a concise incident post-mortem for a developer using only the evidence below. Include the outage duration, what recovered, probable cause (clearly label uncertainty), and one prevention recommendation. Do not invent facts.

Use exactly these sections:
RESOLUTION: what recovered and how long the incident lasted.
PROBABLE CAUSE: evidence-based explanation, or say unclear.
PREVENTION: one practical action to reduce recurrence.

Monitor: ${JSON.stringify(monitorContext)}
Incident: ${JSON.stringify(incidentContext)}`;

    const response = await fetch(`${config.ai.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.ai.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.ai.model,
        messages: [
          { role: 'system', content: 'You are a senior site reliability engineer helping a developer troubleshoot an API outage. Be practical, evidence-led, safe, and explicit about uncertainty. Never fabricate observations.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: type === 'open' ? 700 : 300,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Groq API ${response.status}: ${detail.slice(0, 500)}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    return payload.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    logger.error({ err }, 'AI summary generation failed, falling back to rule-based');
    return generateRuleBasedSummary(type, incident.firstErrorType, incident.lastErrorMessage);
  }
}
