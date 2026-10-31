import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const envPath = join(dirname(fileURLToPath(import.meta.url)), '.env');
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const app = express();
const PORT = 3003;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

const sannataKey = process.env.SANNATA_INGESTION_KEY;
const sannataIngestUrl = process.env.SANNATA_INGEST_URL || 'http://localhost:3001/api/telemetry/events';

// Forward only requests that actually reach this demo API; this does not create traffic.
app.use((req, res, next) => {
  const startedAt = performance.now();

  res.on('finish', () => {
    if (!sannataKey || req.method === 'OPTIONS') return;

    const event = {
      service: 'sannata-demo-api',
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      latencyMs: Math.round(performance.now() - startedAt),
      timestamp: new Date().toISOString(),
    };

    void fetch(sannataIngestUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-sannata-key': sannataKey,
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(5000),
    }).then(async (response) => {
      if (!response.ok) {
        console.error(`Sannata telemetry rejected an event: HTTP ${response.status}`);
      }
    }).catch((error) => {
      console.error('Sannata telemetry delivery failed:', error.message);
    });
  });

  next();
});

// Request logger
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ── State ─────────────────────────────────────────────────────────────────────
let apiState = 'up'; // 'up' | 'down'
let lastSleepyRequest = null; // timestamp (ms) of last /sleepy request

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

const ERRORS = [
  'DB Payment Failure',
  'DB Server is Down',
  'Access Denied',
  'Not Found Error',
];

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /ok — always 200 (unless toggled down)
app.get('/ok', (req, res) => {
  if (apiState === 'down') {
    return res.status(503).json({ status: 'error', message: 'Service Unavailable' });
  }
  res.json({ status: 'ok', message: 'Everything is fine', timestamp: new Date().toISOString() });
});

// GET /flaky — random latency + 1-in-8 chance of 500 error
app.get('/flaky', async (req, res) => {
  if (apiState === 'down') {
    return res.status(503).json({ status: 'error', message: 'Service Unavailable' });
  }

  const start = Date.now();
  const latencyMs = randomInt(100, 2500);
  await sleep(latencyMs);
  const actual = Date.now() - start;

  if (Math.random() < 1 / 8) {
    const message = ERRORS[randomInt(0, ERRORS.length - 1)];
    return res.status(500).json({ status: 'error', message });
  }

  res.json({ status: 'ok', latencyMs: actual, timestamp: new Date().toISOString() });
});

// GET /sleepy — simulates cold start: slow if idle >60s, fast otherwise
app.get('/sleepy', async (req, res) => {
  if (apiState === 'down') {
    return res.status(503).json({ status: 'error', message: 'Service Unavailable' });
  }

  const now = Date.now();
  const idleSince = lastSleepyRequest;
  const wasAsleep = idleSince === null || now - idleSince > 60_000;

  // Update last request time immediately before the delay
  lastSleepyRequest = now;

  const start = Date.now();

  if (wasAsleep) {
    // Cold start — simulate 8 second warm-up
    await sleep(8000);
  } else {
    // Warm — respond quickly
    await sleep(randomInt(50, 180));
  }

  const latencyMs = Date.now() - start;
  res.json({ status: 'ok', wasAsleep, latencyMs, timestamp: new Date().toISOString() });
});

// GET /down — always 503
app.get('/down', (_req, res) => {
  res.status(503).json({ status: 'error', message: 'Service Unavailable' });
});

// GET /slow — always waits 6 seconds
app.get('/slow', async (_req, res) => {
  await sleep(6000);
  res.json({ status: 'ok', message: 'That was slow', latencyMs: 6000, timestamp: new Date().toISOString() });
});

// POST /echo — echo back the request
app.post('/echo', (req, res) => {
  res.json({
    method: req.method,
    url: req.url,
    headers: req.headers,
    body: req.body,
    timestamp: new Date().toISOString(),
  });
});

// GET /toggle?state=down|up — toggle API state
app.get('/toggle', (req, res) => {
  const { state } = req.query;
  if (state === 'down' || state === 'up') {
    apiState = state;
    console.log(`[${new Date().toISOString()}] API state toggled to: ${apiState}`);
  }
  res.json({ state: apiState });
});

// GET /state — return current state and uptime
app.get('/state', (_req, res) => {
  res.json({ state: apiState, uptime: process.uptime() });
});

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] 🚀 Demo API running on http://localhost:${PORT}`);
  console.log(`  Sannata telemetry ${sannataKey ? 'enabled' : 'disabled (set SANNATA_INGESTION_KEY to enable)'}`);
  console.log(`  GET  /ok          → always 200`);
  console.log(`  GET  /flaky       → random latency + 1/8 chance of 500`);
  console.log(`  GET  /sleepy      → cold-start simulation (8s if idle >60s)`);
  console.log(`  GET  /down        → always 503`);
  console.log(`  GET  /slow        → always 6s delay`);
  console.log(`  POST /echo        → echo request`);
  console.log(`  GET  /toggle      → ?state=down|up`);
  console.log(`  GET  /state       → current state`);
});
