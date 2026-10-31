import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, Check, Copy, KeyRound, Radio, RefreshCw, ShieldCheck, Wifi, WifiOff } from 'lucide-react';
import { api, message } from '../api';

type RequestEvent = {
  _id?: string;
  service: string;
  method: string;
  path: string;
  statusCode: number;
  latencyMs: number;
  occurredAt: string;
  correlationId?: string | null;
  errorType?: string | null;
  errorMessage?: string | null;
};

const expressExample = `import express from 'express';
import { randomUUID } from 'node:crypto';

const app = express();
const sannataKey = process.env.SANNATA_INGESTION_KEY;
const sannataIngestUrl = process.env.SANNATA_INGEST_URL;

app.use((req, res, next) => {
  const startedAt = performance.now();
  const correlationId = req.get('x-request-id') || randomUUID();

  res.on('finish', () => {
    if (!sannataKey || !sannataIngestUrl) return;

    const event = {
      service: process.env.SERVICE_NAME || 'my-api',
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      latencyMs: Math.round(performance.now() - startedAt),
      timestamp: new Date().toISOString(),
      correlationId,
    };

    void fetch(sannataIngestUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-sannata-key': sannataKey,
      },
      body: JSON.stringify(event),
    }).catch((error) => console.error('Sannata event delivery failed:', error));
  });

  next();
});`;

export default function Realtime() {
  const [events, setEvents] = useState<RequestEvent[]>([]);
  const [keyConfigured, setKeyConfigured] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');

  const load = useCallback(async () => {
    try {
      const [eventResponse, keyResponse] = await Promise.all([
        api.get('/api/telemetry/events', { params: { limit: 50 } }),
        api.get('/api/telemetry/key'),
      ]);
      setEvents(eventResponse.data.events);
      setKeyConfigured(keyResponse.data.configured);
      setError('');
    } catch (requestError) {
      setError(message(requestError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const baseUrl = api.defaults.baseURL || window.location.origin;
    const url = new URL('/api/telemetry/stream', baseUrl).toString();
    const source = new EventSource(url, { withCredentials: true });

    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.addEventListener('request', (rawEvent) => {
      const event = JSON.parse((rawEvent as MessageEvent<string>).data) as RequestEvent;
      setEvents((current) => [event, ...current.filter((item) => item._id !== event._id)].slice(0, 100));
    });

    return () => {
      source.close();
      setConnected(false);
    };
  }, []);

  const latestEvent = useMemo(() => events[0], [events]);
  const manageKey = async (revoke = false) => {
    setBusy(true);
    setError('');
    setNewKey('');
    try {
      if (revoke) {
        await api.delete('/api/telemetry/key');
        setKeyConfigured(false);
      } else {
        const { data } = await api.post('/api/telemetry/key');
        setNewKey(data.key);
        setKeyConfigured(true);
      }
    } catch (requestError) {
      setError(message(requestError));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      window.setTimeout(() => setCopied(''), 1800);
    } catch {
      setError('Clipboard access failed. Select and copy the text instead.');
    }
  };

  const ingestUrl = `${api.defaults.baseURL || window.location.origin}/api/telemetry/events`;

  return <>
    <div className="page-heading analytics-page-heading">
      <div>
        <p className="eyebrow">LIVE OPERATIONS</p>
        <h1>Real-time activity</h1>
        <p className="muted">Actual requests observed by the Sannata middleware installed in your API.</p>
      </div>
      <span className={`telemetry-connection ${connected ? 'connected' : ''}`}>
        {connected ? <Wifi size={15}/> : <WifiOff size={15}/>}
        {connected ? 'Live stream connected' : 'Connecting to live stream'}
      </span>
    </div>
    {error && <div className="error-banner">{error}</div>}

    <section className="panel telemetry-onboarding">
      <div className="panel-heading">
        <div><h3><ShieldCheck size={17}/> Connect an API</h3><p>Only requests that reach an application instrumented with this integration are visible.</p></div>
        <div className="telemetry-key-actions">
          <button className="primary-button" onClick={() => manageKey()} disabled={busy}>
            <KeyRound size={15}/>{busy ? 'Working…' : keyConfigured ? 'Rotate ingestion key' : 'Generate ingestion key'}
          </button>
          {keyConfigured && <button className="subtle-button" onClick={() => manageKey(true)} disabled={busy}>Revoke</button>}
        </div>
      </div>
      {newKey && <div className="telemetry-secret">
        <b>Copy this key now. It is shown only once.</b>
        <code>{newKey}</code>
        <button className="secondary-button" onClick={() => copy(newKey, 'key')}><Copy size={14}/>{copied === 'key' ? 'Copied' : 'Copy key'}</button>
      </div>}
      <p className="telemetry-config-note">
        Set <code>SANNATA_INGESTION_KEY</code> to the key above and <code>SANNATA_INGEST_URL</code> to <code>{ingestUrl}</code> in your API's environment. Keep the key server-side; never expose it in browser code.
      </p>
      <details className="telemetry-example">
        <summary>Express middleware example</summary>
        <div className="telemetry-code-heading">
          <span>Records method, path, status, latency, timestamp and correlation ID after each response.</span>
          <button className="subtle-button" onClick={() => copy(expressExample, 'example')}><Copy size={13}/>{copied === 'example' ? 'Copied' : 'Copy example'}</button>
        </div>
        <pre><code>{expressExample}</code></pre>
      </details>
    </section>

    <section className="panel analytics-panel telemetry-events">
      <div className="panel-heading">
        <div><h3><Radio size={16}/> Incoming request events</h3><p>Live event stream; no scheduled checks or generated traffic are included.</p></div>
        <button className="secondary-button" onClick={() => void load()} disabled={loading}><RefreshCw size={14} className={loading ? 'spin' : ''}/> Load history</button>
      </div>
      <div className="telemetry-last-event">
        <Activity size={15}/>
        <span>Last received event</span>
        <b>{latestEvent ? new Date(latestEvent.occurredAt).toLocaleString() : 'No request received yet'}</b>
      </div>
      <div className="analytics-table-wrap">
        <table className="analytics-table">
          <thead><tr><th>Service / endpoint</th><th>Method</th><th>HTTP</th><th>Latency</th><th>Timestamp</th><th>Correlation ID</th></tr></thead>
          <tbody>{events.map((event, index) => <tr key={event._id || `${event.occurredAt}-${index}`}>
            <td><b>{event.service}</b><small>{event.path}</small>{event.errorMessage && <small className="state-bad">{event.errorType ? `${event.errorType}: ` : ''}{event.errorMessage}</small>}</td>
            <td>{event.method}</td><td><span className={event.statusCode >= 500 ? 'state-bad' : event.statusCode >= 400 ? 'state-warn' : 'state-good'}>{event.statusCode}</span></td>
            <td>{event.latencyMs} ms</td><td>{new Date(event.occurredAt).toLocaleString()}</td><td>{event.correlationId || '—'}</td>
          </tr>)}</tbody>
        </table>
        {!events.length && <div className="analytics-empty-inline">{loading ? 'Loading saved request events…' : keyConfigured ? 'No request events yet. Requests will appear after your integrated API sends them.' : 'Generate an ingestion key and add the middleware to your API to begin.'}</div>}
      </div>
    </section>
  </>;
}
