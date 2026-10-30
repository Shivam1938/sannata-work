import axios, { AxiosError } from 'axios';
import https from 'https';
import http from 'http';
import { checkSsrf, SsrfError } from './ssrf-guard.js';
import { decrypt } from './crypto.js';
import type { IMonitor } from '../models/Monitor.js';
import type { CheckClassification, ErrorType, ICheckResult } from '../models/CheckResult.js';
import { CheckResult } from '../models/CheckResult.js';
import { Monitor } from '../models/Monitor.js';
import { logger } from '../config/logger.js';

const MAX_RESPONSE_BYTES = 1_048_576; // 1 MB
const MAX_REDIRECTS = 5;
const RETRY_DELAY_MS = 10_000;
const RETRY_ATTEMPTS = 3;

export interface CheckOutcome {
  success: boolean;
  classification: CheckClassification;
  statusCode: number | null;
  responseTimeMs: number | null;
  attempts: number;
  errorType: ErrorType | null;
  errorMessage: string | null;
  responseSizeBytes: number | null;
}

/** Parse expected status codes list which may include ranges like "200-299" */
function statusCodeMatches(code: number, expected: (number | string)[]): boolean {
  for (const entry of expected) {
    if (typeof entry === 'number') {
      if (code === entry) return true;
    } else {
      const match = String(entry).match(/^(\d+)-(\d+)$/);
      if (match) {
        const [, lo, hi] = match;
        if (code >= parseInt(lo, 10) && code <= parseInt(hi, 10)) return true;
      } else {
        if (code === parseInt(entry, 10)) return true;
      }
    }
  }
  return false;
}

/** Evaluate assertions against response body */
function evaluateAssertions(
  assertions: IMonitor['assertions'],
  body: string
): { passed: boolean; message?: string } {
  for (const assertion of assertions) {
    if (assertion.type === 'body_contains') {
      if (!body.includes(assertion.value)) {
        return { passed: false, message: `Body does not contain "${assertion.value}"` };
      }
    } else if (assertion.type === 'json_path_equals') {
      try {
        const parsed = JSON.parse(body);
        // Simple dot-notation path resolver
        const parts = (assertion.path || '').split('.');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let val: any = parsed;
        for (const part of parts) {
          if (val === undefined || val === null) break;
          val = val[part];
        }
        if (String(val) !== assertion.value) {
          return { passed: false, message: `JSON path "${assertion.path}" is "${val}", expected "${assertion.value}"` };
        }
      } catch {
        return { passed: false, message: 'Response body is not valid JSON' };
      }
    }
  }
  return { passed: true };
}

/** Classify an error from Axios into our ErrorType enum */
function classifyError(err: unknown): { errorType: ErrorType; errorMessage: string } {
  if (err instanceof SsrfError) {
    return { errorType: 'ssrf', errorMessage: `Target not allowed: ${err.message}` };
  }
  if (axios.isAxiosError(err)) {
    const ae = err as AxiosError;
    const code = ae.code;
    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
      return { errorType: 'timeout', errorMessage: 'Request timed out' };
    }
    if (code === 'ENOTFOUND' || code === 'EAI_NONAME') {
      return { errorType: 'dns', errorMessage: `DNS lookup failed: ${ae.config?.url || ''}` };
    }
    if (code === 'ECONNREFUSED') {
      return { errorType: 'connection_refused', errorMessage: 'Connection refused' };
    }
    if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'SELF_SIGNED_CERT_IN_CHAIN') {
      return { errorType: 'tls', errorMessage: `TLS error: ${code}` };
    }
    if (code === 'ERR_FR_TOO_MANY_REDIRECTS' || code === 'EMAXREDIRECTS') {
      return { errorType: 'redirect_loop', errorMessage: `Too many redirects (max ${MAX_REDIRECTS})` };
    }
    if (ae.response?.status) {
      return {
        errorType: 'bad_status',
        errorMessage: `Unexpected status code: ${ae.response.status}`,
      };
    }
    return { errorType: 'unknown', errorMessage: ae.message || 'Unknown error' };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return { errorType: 'unknown', errorMessage: msg };
}

/**
 * Perform a single attempt at checking a monitor.
 * Returns outcome data; does NOT save to DB.
 */
async function attemptCheck(
  monitor: IMonitor,
  attempt: number
): Promise<{ success: boolean; statusCode: number | null; responseTimeMs: number; responseSizeBytes: number | null; errorType: ErrorType | null; errorMessage: string | null }> {
  // SSRF guard first
  try {
    await checkSsrf(monitor.url);
  } catch (err) {
    const { errorType, errorMessage } = classifyError(err);
    return { success: false, statusCode: null, responseTimeMs: 0, responseSizeBytes: null, errorType, errorMessage };
  }

  // Decrypt headers
  const decryptedHeaders: Record<string, string> = {};
  for (const h of monitor.headers) {
    if (h.enabled) {
      try {
        decryptedHeaders[h.key] = decrypt(h.value);
      } catch {
        decryptedHeaders[h.key] = h.value; // fallback for unencrypted (shouldn't happen in prod)
      }
    }
  }

  // Apply auth
  if (monitor.authType === 'bearer' && monitor.authCredentials) {
    try {
      decryptedHeaders['Authorization'] = `Bearer ${decrypt(monitor.authCredentials)}`;
    } catch {
      decryptedHeaders['Authorization'] = `Bearer ${monitor.authCredentials}`;
    }
  } else if (monitor.authType === 'basic' && monitor.authCredentials) {
    let creds = monitor.authCredentials;
    try { creds = decrypt(monitor.authCredentials); } catch {}
    decryptedHeaders['Authorization'] = `Basic ${Buffer.from(creds).toString('base64')}`;
  }

  // Set content-type for body
  if (monitor.bodyType === 'json' && !decryptedHeaders['Content-Type']) {
    decryptedHeaders['Content-Type'] = 'application/json';
  }

  const start = Date.now();
  let responseTimeMs = 0;
  let responseSizeBytes: number | null = null;
  let statusCode: number | null = null;

  try {
    const agent = monitor.url.startsWith('https') 
      ? new https.Agent({ rejectUnauthorized: true })
      : new http.Agent();

    const response = await axios({
      method: monitor.method,
      url: monitor.url,
      headers: decryptedHeaders,
      data: monitor.bodyType !== 'none' ? monitor.body : undefined,
      timeout: monitor.timeoutMs,
      maxRedirects: MAX_REDIRECTS,
      maxContentLength: MAX_RESPONSE_BYTES,
      maxBodyLength: MAX_RESPONSE_BYTES,
      validateStatus: () => true, // don't throw on any status
      httpsAgent: agent,
      httpAgent: agent,
      decompress: true,
      responseType: 'text',
    });

    responseTimeMs = Date.now() - start;
    statusCode = response.status;
    const responseBody = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
    responseSizeBytes = Buffer.byteLength(responseBody, 'utf8');

    // Status check
    if (!statusCodeMatches(statusCode, monitor.expectedStatusCodes)) {
      return {
        success: false,
        statusCode,
        responseTimeMs,
        responseSizeBytes,
        errorType: 'bad_status',
        errorMessage: `Expected ${monitor.expectedStatusCodes.join(', ')}, got ${statusCode}`,
      };
    }

    // Assertions
    if (monitor.assertions && monitor.assertions.length > 0) {
      const { passed, message } = evaluateAssertions(monitor.assertions, responseBody);
      if (!passed) {
        return { success: false, statusCode, responseTimeMs, responseSizeBytes, errorType: 'assertion_failed', errorMessage: message || 'Assertion failed' };
      }
    }

    return { success: true, statusCode, responseTimeMs, responseSizeBytes, errorType: null, errorMessage: null };
  } catch (err) {
    responseTimeMs = Date.now() - start;
    // Check if it was a size limit
    if (axios.isAxiosError(err) && err.code === 'ERR_FR_MAX_BODY_LENGTH_EXCEEDED') {
      return { success: false, statusCode, responseTimeMs, responseSizeBytes, errorType: 'too_large', errorMessage: 'Response exceeded 1 MB limit' };
    }
    const { errorType, errorMessage } = classifyError(err);
    if (axios.isAxiosError(err) && err.response) {
      statusCode = err.response.status;
    }
    return { success: false, statusCode, responseTimeMs, responseSizeBytes, errorType, errorMessage };
  }
}

/** Is this an error type that suggests a cold start (transient / server sleeping)? */
function isColdStartErrorType(errorType: ErrorType | null): boolean {
  return errorType === 'timeout' || errorType === 'bad_status';
}

/** Is a status code one of the cold-start typical codes? */
function isColdStartStatusCode(code: number | null): boolean {
  return code === 502 || code === 503 || code === 504;
}

/**
 * Run a full check for a monitor (with retry logic).
 * Returns the final CheckOutcome.
 */
export async function performCheck(
  monitor: IMonitor,
  options: { retry?: boolean } = {},
): Promise<CheckOutcome> {
  const maxAttempts = options.retry === false ? 1 : RETRY_ATTEMPTS;
  let lastResult: Awaited<ReturnType<typeof attemptCheck>> | null = null;
  let hadEarlyFailure = false;
  let totalAttempts = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      // Wait 10s between retries
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }

    totalAttempts++;
    const result = await attemptCheck(monitor, attempt);
    lastResult = result;

    if (result.success) {
      // Successful check — classify it
      let classification: CheckClassification = 'ok';

      if (!result.success) {
        classification = 'failed';
      } else if (monitor.coldStartAware) {
        // Cold start: had earlier failures in this same check OR response is much slower than usual
        if (hadEarlyFailure) {
          classification = 'cold_start';
        }
        // Note: median-based cold start detection is done post-save in the stats service
        // Here we mark based on retry evidence
      }

      return {
        success: true,
        classification,
        statusCode: result.statusCode,
        responseTimeMs: result.responseTimeMs,
        attempts: totalAttempts,
        errorType: null,
        errorMessage: null,
        responseSizeBytes: result.responseSizeBytes,
      };
    }

    // Track if early failure looks like cold-start pattern
    if (
      monitor.coldStartAware &&
      (isColdStartErrorType(result.errorType) || isColdStartStatusCode(result.statusCode))
    ) {
      hadEarlyFailure = true;
    }

    // On final attempt or non-retryable error, stop retrying
    // Non-retryable: assertion_failed, ssrf, too_large
    if (
      attempt === maxAttempts - 1 ||
      result.errorType === 'assertion_failed' ||
      result.errorType === 'ssrf' ||
      result.errorType === 'too_large'
    ) {
      break;
    }
  }

  // All attempts failed
  return {
    success: false,
    classification: 'failed',
    statusCode: lastResult!.statusCode,
    responseTimeMs: lastResult!.responseTimeMs,
    attempts: totalAttempts,
    errorType: lastResult!.errorType,
    errorMessage: lastResult!.errorMessage,
    responseSizeBytes: lastResult!.responseSizeBytes,
  };
}

/**
 * Classify a successful check as cold_start using the historical median method.
 * Call this AFTER saving the CheckResult, with access to recent history.
 */
export async function reclassifyAsColdStartIfNeeded(
  checkResultId: string,
  monitorId: string,
  responseTimeMs: number,
  hadRetryFailure: boolean
): Promise<boolean> {
  if (hadRetryFailure) return true; // already cold start

  // Get last 20 successful non-cold checks for this monitor
  const recentChecks = await CheckResult.find({
    monitorId,
    success: true,
    classification: { $in: ['ok', 'slow'] },
  })
    .sort({ checkedAt: -1 })
    .limit(20)
    .select('responseTimeMs')
    .lean();

  if (recentChecks.length < 3) return false; // not enough history

  const times = recentChecks
    .map((c) => c.responseTimeMs)
    .filter((t): t is number => t !== null)
    .sort((a, b) => a - b);

  const median = times[Math.floor(times.length / 2)];
  const threshold = Math.max(2000, median * 4);

  return responseTimeMs > threshold;
}

/**
 * Save a CheckResult and update the Monitor document.
 */
export async function saveCheckResult(
  monitor: IMonitor,
  outcome: CheckOutcome
): Promise<ICheckResult> {
  const check = new CheckResult({
    monitorId: monitor._id,
    userId: monitor.userId,
    checkedAt: new Date(),
    success: outcome.success,
    classification: outcome.classification,
    statusCode: outcome.statusCode,
    responseTimeMs: outcome.responseTimeMs,
    attempts: outcome.attempts,
    errorType: outcome.errorType,
    errorMessage: outcome.errorMessage,
    responseSizeBytes: outcome.responseSizeBytes,
  });
  await check.save();

  // Update monitor's last check fields
  await Monitor.findByIdAndUpdate(monitor._id, {
    lastCheckedAt: check.checkedAt,
    lastResponseTimeMs: outcome.responseTimeMs,
  });

  return check;
}
