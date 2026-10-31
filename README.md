# Sannata 🌙 — API Health & Performance Monitoring

**Chup hai, matlab sab theek hai.** Sannata is an outside-in API monitoring platform for indie developers and students. Add an endpoint, let scheduled checks watch it, and get notified when an issue is confirmed—not for every slow cold start.

> This repository is a student/minor-project implementation. Before exposing it to the public internet, review the security notes below, configure secrets, and run the full test and acceptance checklist.

## Features

- Email/password authentication with JWT in an HttpOnly cookie.
- Monitor CRUD, pause/resume, expected status codes, request headers/body and per-monitor timeouts.
- BullMQ + Redis repeatable monitoring jobs with startup reconciliation; worker can run separately or inside the API process.
- Retry-based failure confirmation and cold-start classification.
- Check history, uptime, average latency, p95/p99 and time-series data.
- Incident open/resolve lifecycle, Telegram and SMTP email alerts.
- Rule-based incident summary with optional Anthropic summary support.
- Request tester, recent request history and save-as-monitor action.
- Public status pages, free/pro plan limits and demo upgrade mode.
- SSRF guard, encrypted monitor secrets, Helmet, CORS, rate limits and Zod validation.
- Demo API endpoints for healthy, flaky, sleeping, slow and unavailable services.

## Architecture

```text
React + Vite client (:5173)
        │ HttpOnly cookie / REST
        ▼
Express + TypeScript API (:3001) ───── MongoDB (:27017)
        │                                    ▲
        ├── BullMQ queue ─── Redis (:6379)   │
        │                    ▲               │
        └── Worker (same process or separate)┘

Demo API (:3003)  ← target for local monitoring checks
```

## Requirements

- Node.js 20 LTS or newer and npm.
- Docker Desktop (recommended for MongoDB and Redis).
- Optional: Telegram bot token, SMTP credentials and Anthropic API key.

## Quick start (Windows PowerShell)

1. Extract the repository and open a terminal in the root folder.
2. Install dependencies:

```powershell
npm run install:all
```

3. Start MongoDB and Redis:

```powershell
docker compose up -d
```

4. Create the server environment file:

```powershell
Copy-Item server/.env.example server/.env
```

Keep the development `ENCRYPTION_KEY` from the example for local testing only. For a real deployment, generate a fresh 32-byte key encoded as 64 hex characters and use a strong JWT secret. Do not commit `.env` files.

5. Start the four processes in four separate terminals from the repository root:

```powershell
npm run dev:server
npm run dev:worker
npm run dev:demo
npm run dev:client
```

Open **http://localhost:5173**. The API health endpoint is **http://localhost:3001/health** and the demo API is **http://localhost:3003/ok**.

### Seed data (optional)

With MongoDB and Redis running, use:

```powershell
npm run seed
```

The seed script creates the demo account and example monitors. Check `server/src/scripts/seed.ts` for the current demo credentials before using it. Do not use demo credentials in a deployed environment.

## Environment variables

See `server/.env.example` and `client/.env.example`.

| Variable | Purpose |
|---|---|
| `PORT` | Express API port (default 3001) |
| `MONGODB_URI` | MongoDB connection string |
| `REDIS_URL` | Redis connection string for BullMQ |
| `JWT_SECRET` | JWT signing secret |
| `ENCRYPTION_KEY` | 64-character hex key for AES-256-GCM |
| `CLIENT_URL` | Exact frontend origin for credentialed CORS |
| `RUN_WORKER` | Set to `true` to run BullMQ workers inside the API process; defaults to `false` |
| `ALLOW_PRIVATE_TARGETS` | Local-only switch for testing localhost targets; keep `false` outside local development |
| `DEMO_MODE` | Enables the no-payment Pro demo upgrade when `true` |
| `TELEGRAM_BOT_TOKEN` | Optional Telegram bot token |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | Optional SMTP settings |
| `ANTHROPIC_API_KEY`, `AI_MODEL` | Optional AI incident summary settings |

## Demo API

The demo API listens on port 3003:

- `GET /ok` — always healthy.
- `GET /flaky` — random latency and intermittent 500 responses.
- `GET /sleepy` — waits after an idle period to simulate a cold start.
- `GET /down` — always responds with 503.
- `GET /slow` — delayed response.
- `POST /echo` — echoes request details.
- `GET /toggle?state=down|up` and `GET /state` — manually control the demo service.

When monitoring localhost demo endpoints, set `ALLOW_PRIVATE_TARGETS=true` in `server/.env` for local development only. Restart both API and worker after changing it.

## Deploy API and worker together on Render

The backend can process scheduled BullMQ jobs in the API Web Service process, so a separate Background Worker is optional:

1. Create a Render Web Service for this repository with **Root Directory** `server`.
2. Set **Build Command** to `npm ci --include=dev && npm run build` and **Start Command** to `npm run start`.
3. Configure the required production variables (`MONGODB_URI`, `REDIS_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`, and `CLIENT_URL`) and set `RUN_WORKER=true`.
4. Keep this Web Service at one instance when using the embedded worker. Do not also deploy the standalone worker for the same queues.

Render environment setting:

```text
RUN_WORKER=true
```

Leave `RUN_WORKER` unset or `false` when deploying the API and worker as separate services. The standalone worker command remains `npm run worker:start`.

## Deploy the frontend on Vercel

Set the Vercel project root directory to `client`, with `npm run build` as the build command and `dist` as the output directory. The checked-in `client/vercel.json` proxies `/api/*` requests to the Render API and rewrites frontend routes to `index.html`. This keeps browser authentication cookies on the Vercel origin. Do not set `VITE_API_URL` to the Render domain; leave it unset so production requests use the Vercel origin and its API proxy. Set the Render `CLIENT_URL` to the Vercel site origin (without `/login` or a trailing slash).

## Useful commands

```powershell
npm run build:server
npm run build:client
npm test
npm run docker:down
```

## Plans

- **Free:** up to 5 monitors, minimum 5-minute interval, 7-day history.
- **Pro demo:** up to 50 monitors, 1-minute minimum interval, 30-day history and AI summaries.
- Payments are not integrated. Demo upgrade only changes the account plan when `DEMO_MODE=true`.

## Important implementation/security notes

- Do not set `ALLOW_PRIVATE_TARGETS=true` in production. It deliberately permits local targets for the demo API.
- Keep `ENCRYPTION_KEY`, JWT secret, Telegram token, SMTP password and Anthropic key private.
- Use HTTPS and set production cookie/CORS configuration before deployment.
- Public status pages expose only monitors explicitly selected for the status page.
- The request tester is rate-limited at the application level in production deployments; add reverse-proxy rate limiting and outbound network restrictions before public hosting.
- Scheduled checks require a worker: either enable the embedded worker with `RUN_WORKER=true`, or run the standalone worker alongside the API.
- For a single Render Free Web Service, set `RUN_WORKER=true` on the API service to run both in one process. Do not also run the separate worker service in that setup. Use one API instance when embedding the worker; multiple instances each start a worker.
- Local development scripts are unchanged: `npm run dev:server` starts only the API and `npm run dev:worker` starts the separate worker. To test embedded mode locally, set `RUN_WORKER=true` in `server/.env` and run the API only.
- External Telegram, SMTP and Anthropic integrations require credentials and cannot be validated without them.

## Verification checklist

- [ ] Signup, login, `/api/auth/me` and logout work.
- [ ] Add, edit, pause, resume and delete a monitor.
- [ ] A monitor gets scheduled and the worker records check results.
- [ ] `/flaky`, `/sleepy` and `/down` demonstrate the expected classifications and incident lifecycle.
- [ ] Uptime and latency stats appear in the dashboard and monitor detail.
- [ ] Request tester sends requests and stores history.
- [ ] Telegram/email test alerts work after credentials are configured.
- [ ] Public status page is accessible without login.
- [ ] SSRF tests and unit tests pass.

## Project structure

```text
client/             React 18 + Vite dashboard
server/             Express API, models, services and worker
demo-api/           Flaky API for end-to-end testing
shared/             Reserved for future shared contracts
docker-compose.yml  MongoDB + Redis
```

## Plan behavior (Free and Pro)

The plan shown in the workspace is backed by the MongoDB user record. The API resolves the current plan from MongoDB on every authenticated request; it does not trust the older plan value embedded in the login cookie. This is important because upgrading should enable Pro limits immediately without requiring the user to sign out and back in.

- **Free:** up to 5 monitors, minimum 300-second interval, 7 days of retained check history, and 30 request-tester calls per minute.
- **Pro demo:** up to 50 monitors, minimum 60-second interval, 30 days of retained check history, AI incident summaries when `ANTHROPIC_API_KEY` is configured (rule-based fallback otherwise), custom public status-page title, higher-priority BullMQ checks, and 120 request-tester calls per minute.
- **Demo subscription duration:** 30 days from activation. The workspace plan control and Pricing/Settings pages show the expiry date and time. Expired subscriptions automatically return to Free on the next authenticated request. Monitors configured below the Free minimum are moved to 5-minute checks on downgrade.
- A Pro account cannot switch itself back to Free from the Pricing screen. The workspace dropdown opens subscription details; it is not a plan switcher.

The demo upgrade is not a payment integration. It only works while `DEMO_MODE=true`.

## External integrations are credential-dependent

Sannata can only deliver email, Telegram, and Anthropic-powered summaries when the corresponding credentials are configured in `server/.env`:

- **Email:** SMTP host, port, username, password/app-password, and sender address. For Gmail, use an app password with an account that has 2-step verification enabled.
- **Telegram:** bot token and bot username. The user must also connect the Telegram chat from Settings using the generated `/start` link. `TELEGRAM_MODE=polling` works for local development; webhook mode requires a publicly reachable HTTPS endpoint configured with Telegram.
- **AI summaries:** Anthropic API key and a model supported by the Anthropic account. Without a key, Pro incidents still receive a rule-based summary rather than failing.

Settings now reports whether SMTP, Telegram bot credentials, and the Anthropic API key are present. A test button cannot send a real external message if the relevant credentials are missing.
