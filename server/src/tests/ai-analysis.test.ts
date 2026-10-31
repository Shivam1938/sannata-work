import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config/index.js';
import { generateAiSummary, INCIDENT_REPORT_HEADINGS, isCompleteIncidentReport } from '../services/ai.js';

const report = INCIDENT_REPORT_HEADINGS.map((heading) => `## ${heading}\nEvidence unavailable.`).join('\n\n');
const monitor = {
  name: 'API',
  url: 'https://api.example.test/health',
  method: 'GET' as const,
  expectedStatusCodes: ['200-299'],
  timeoutMs: 10000,
  failureThreshold: 2,
};
const incident = {
  status: 'open' as const,
  startedAt: new Date('2026-10-31T00:00:00.000Z'),
  resolvedAt: null,
  durationSeconds: null,
  firstErrorType: 'timeout' as const,
  failedChecksCount: 2,
  lastErrorMessage: 'Timed out',
};

describe('evidence-based AI incident report', () => {
  const previousKey = config.ai.apiKey;
  const previousBaseUrl = config.ai.baseUrl;

  afterEach(() => {
    config.ai.apiKey = previousKey;
    config.ai.baseUrl = previousBaseUrl;
    vi.unstubAllGlobals();
  });

  it('rejects incomplete provider output', () => {
    expect(isCompleteIncidentReport('## Incident summary\nOnly one section')).toBe(false);
    expect(isCompleteIncidentReport(report)).toBe(true);
  });

  it('returns a structured report using the configured server-side credential', async () => {
    config.ai.apiKey = 'test-only-secret';
    config.ai.baseUrl = 'https://provider.example.test/v1';
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-only-secret');
      return new Response(JSON.stringify({ choices: [{ message: { content: report } }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateAiSummary('open', monitor, incident, [])).resolves.toBe(report);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('surfaces provider failures instead of returning a success-shaped fallback', async () => {
    config.ai.apiKey = 'test-only-secret';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })));

    await expect(generateAiSummary('open', monitor, incident, []))
      .rejects.toMatchObject({ statusCode: 502, code: 'AI_PROVIDER_ERROR' });
  });
});
