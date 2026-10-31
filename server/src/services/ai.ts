import { config } from '../config/index.js';
import { logger } from '../config/logger.js';
import type { IMonitor } from '../models/Monitor.js';
import type { IIncident } from '../models/Incident.js';
import type { ICheckResult, ErrorType } from '../models/CheckResult.js';
import { createError } from '../middleware/errorHandler.js';

export const INCIDENT_REPORT_HEADINGS = [
  'Incident summary',
  'Severity and impact',
  'Confirmed evidence',
  'Root cause analysis',
  'Likely technical causes',
  'Recommended resolution',
  'Verification checklist',
  'Prevention recommendations',
  'Confidence',
] as const;

export function isCompleteIncidentReport(report: string | null | undefined): report is string {
  return Boolean(report?.trim())
    && INCIDENT_REPORT_HEADINGS.every((heading) => report!.includes(`## ${heading}`));
}

type MonitorEvidence = Pick<IMonitor, 'name' | 'url' | 'method' | 'expectedStatusCodes' | 'timeoutMs' | 'failureThreshold'>;
type IncidentEvidence = Pick<IIncident, 'status' | 'startedAt' | 'resolvedAt' | 'durationSeconds' | 'firstErrorType' | 'failedChecksCount' | 'lastErrorMessage'>;

export function generateRuleBasedSummary(
  type: 'open' | 'resolved',
  errorType: ErrorType | null | string,
  _errorMessage: string | null,
): string {
  if (type === 'resolved') return 'The monitor has recovered and is now responding normally.';
  switch (errorType) {
    case 'timeout': return 'The endpoint did not respond within its configured timeout.';
    case 'dns': return 'The endpoint hostname could not be resolved during the check.';
    case 'connection_refused': return 'The target refused the connection during the check.';
    case 'tls': return 'The connection failed during TLS negotiation.';
    case 'bad_status': return 'The endpoint returned an HTTP status outside its configured expectation.';
    case 'assertion_failed': return 'The response did not satisfy the monitor assertions.';
    case 'ssrf': return 'The target was rejected by the server-side request safety policy.';
    default: return 'The check failed; the saved monitoring evidence does not identify a more specific cause.';
  }
}

export async function generateAiSummary(
  type: 'open' | 'resolved',
  monitor: MonitorEvidence,
  incident: IncidentEvidence,
  recentChecks: Pick<
    ICheckResult,
    'statusCode' | 'responseTimeMs' | 'errorType' | 'errorMessage' | 'attempts' |
    'checkedAt' | 'success' | 'classification'
  >[],
): Promise<string> {
  if (!config.ai.apiKey) {
    throw createError('AI analysis is not configured on this Sannata server.', 503, 'AI_NOT_CONFIGURED');
  }

  const prompt = `Write a professional SRE incident report. Use only the monitor configuration, incident fields, and saved checks below. Never claim access to application logs, source code, cloud dashboards, databases, or dependencies. Separate confirmed facts from hypotheses; call out missing evidence. Do not invent dates, HTTP statuses, or response times.

Return Markdown with exactly these headings:
## Incident summary
Summarize what failed or recovered, when, the endpoint, and the recorded duration if available.
## Severity and impact
Choose Critical, High, Medium, or Low. Explain only the impact supported by this endpoint's monitoring evidence; do not infer customer or business impact.
## Confirmed evidence
List dated facts from saved checks and incident fields. State when relevant information is not recorded.
## Root cause analysis
Give the strongest evidence-based diagnosis and distinguish facts from hypotheses.
## Likely technical causes
Rank up to three possibilities, label each Likely, Possible, or Unclear, and cite supporting or contrary evidence.
## Recommended resolution
Provide ordered, safe steps to investigate and resolve the issue without inventing code, file names, or configuration.
## Verification checklist
List measurable checks based on the configured expected status, latency, and subsequent monitoring results when available.
## Prevention recommendations
Give proportionate monitoring or operational steps to reduce recurrence.
## Confidence
Choose High, Medium, or Low and explain the evidence limitation in one sentence.

REPORT TYPE: ${type}
MONITOR CONFIGURATION:
${JSON.stringify({
    name: monitor.name,
    url: monitor.url,
    method: monitor.method,
    expectedStatusCodes: monitor.expectedStatusCodes,
    timeoutMs: monitor.timeoutMs,
    failureThreshold: monitor.failureThreshold,
  })}
INCIDENT:
${JSON.stringify({
    status: incident.status,
    startedAt: incident.startedAt,
    resolvedAt: incident.resolvedAt,
    durationSeconds: incident.durationSeconds,
    firstErrorType: incident.firstErrorType,
    failedChecksCount: incident.failedChecksCount,
    lastErrorMessage: incident.lastErrorMessage,
  })}
RECENT SAVED CHECKS (newest first):
${JSON.stringify(recentChecks.map((check) => ({
    checkedAt: check.checkedAt,
    success: check.success,
    classification: check.classification,
    statusCode: check.statusCode,
    responseTimeMs: check.responseTimeMs,
    errorType: check.errorType,
    errorMessage: check.errorMessage,
    attempts: check.attempts,
  })))}`;

  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(`${config.ai.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.ai.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.ai.model,
        messages: [
          {
            role: 'system',
            content: 'You are a principal Site Reliability Engineer. Produce precise, evidence-grounded incident reports. Never fabricate facts.',
          },
          { role: 'user', content: prompt },
        ],
        max_tokens: 1500,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    logger.error({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'AI provider request failed');
    throw createError('The AI provider could not be reached. Please try again later.', 503, 'AI_PROVIDER_UNAVAILABLE');
  }

  if (!response.ok) {
    logger.warn({ status: response.status }, 'AI provider rejected the incident analysis request');
    throw createError('The AI provider could not complete this analysis. Please try again later.', 502, 'AI_PROVIDER_ERROR');
  }

  let payload: { choices?: Array<{ message?: { content?: string | null } }> };
  try {
    payload = await response.json() as typeof payload;
  } catch {
    throw createError('The AI provider returned an invalid response. Please try again later.', 502, 'AI_INVALID_RESPONSE');
  }
  const analysis = payload.choices?.[0]?.message?.content?.trim();
  if (!isCompleteIncidentReport(analysis)) {
    throw createError('The AI provider returned an incomplete report. Please retry the analysis.', 502, 'AI_INVALID_RESPONSE');
  }
  return analysis;
}
