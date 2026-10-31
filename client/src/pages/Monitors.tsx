import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Activity, Loader2, Pause, Pencil, Play, Plus, Search, Trash2, X } from 'lucide-react';
import { api, message } from '../api';
import { useApp } from '../App';

const blank = {
  name: '', url: '', method: 'GET', intervalSeconds: 300, timeoutMs: 15000,
  expectedStatusCodes: ['200-299'], headers: [], body: '', bodyType: 'none',
  authType: 'none', authCredentials: '', coldStartAware: true, keepAliveEnabled: false,
  failureThreshold: 2, showOnStatusPage: true, assertions: [],
};
const presets = [
  { seconds: 60, label: '1 minute' },
  { seconds: 300, label: '5 minutes' },
  { seconds: 600, label: '10 minutes' },
  { seconds: 1800, label: '30 minutes' },
  { seconds: 3600, label: '1 hour' },
  { seconds: 21600, label: '6 hours' },
  { seconds: 43200, label: '12 hours' },
  { seconds: 86400, label: '1 day' },
];
const unitSeconds = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };
type IntervalUnit = keyof typeof unitSeconds;

export default function Monitors() {
  const { user } = useApp();
  const isPro = user?.plan === 'pro';
  const [items, setItems] = useState<any[]>([]);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<any>(blank);
  const [intervalChoice, setIntervalChoice] = useState('300');
  const [customValue, setCustomValue] = useState(5);
  const [customUnit, setCustomUnit] = useState<IntervalUnit>('minutes');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();

  const load = () => api.get('/api/monitors', { params: { search, status: filter === 'all' ? undefined : filter } })
    .then((response) => setItems(response.data.monitors))
    .catch((requestError) => setError(message(requestError)));

  useEffect(() => { void load(); }, [filter]);
  useEffect(() => {
    if (params.get('new')) {
      openCreate();
      setParams({});
    }
  }, []);

  const availablePresets = useMemo(() => isPro ? presets : presets.filter((item) => item.seconds >= 300 && item.seconds <= 3600), [isPro]);

  function openCreate() {
    setEditingId(null);
    setForm({ ...blank });
    setIntervalChoice('300');
    setCustomValue(5);
    setCustomUnit('minutes');
    setError('');
    setModal(true);
  }

  function openEdit(monitor: any) {
    const nextForm = { ...blank, ...monitor };
    const isPreset = availablePresets.some((item) => item.seconds === nextForm.intervalSeconds);
    setEditingId(monitor._id);
    setForm(nextForm);
    setIntervalChoice(isPreset ? String(nextForm.intervalSeconds) : 'custom');
    setCustomValue(nextForm.intervalSeconds);
    setCustomUnit('seconds');
    setError('');
    setModal(true);
  }

  function setInterval(seconds: number) {
    setForm((current: any) => ({ ...current, intervalSeconds: seconds }));
  }

  function changeCustomInterval(value: number, unit: IntervalUnit) {
    setCustomValue(value);
    setCustomUnit(unit);
    setInterval(value * unitSeconds[unit]);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (editingId) await api.put(`/api/monitors/${editingId}`, form);
      else await api.post('/api/monitors', form);
      setModal(false);
      setNotice(editingId ? 'Monitor updated.' : 'Monitor created.');
      await load();
    } catch (requestError) {
      setError(message(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function checkNow(monitor: any) {
    setChecking(monitor._id);
    setError('');
    setNotice('');
    try {
      const { data } = await api.post(`/api/monitors/${monitor._id}/check-now`);
      setNotice(`${monitor.name}: ${data.outcome.success ? 'UP' : 'DOWN'} · ${data.outcome.responseTimeMs ?? '—'} ms · HTTP ${data.outcome.statusCode ?? 'no response'}`);
      await load();
    } catch (requestError) {
      setError(message(requestError));
    } finally {
      setChecking(null);
    }
  }

  async function action(monitor: any, kind: string) {
    try {
      if (kind === 'delete') {
        if (!confirm(`Delete ${monitor.name}?`)) return;
        await api.delete(`/api/monitors/${monitor._id}`);
      } else {
        await api.post(`/api/monitors/${monitor._id}/${kind}`);
      }
      await load();
    } catch (requestError) {
      setError(message(requestError));
    }
  }

  const intervalIsValid = isPro
    ? Number.isInteger(form.intervalSeconds) && form.intervalSeconds >= 60 && form.intervalSeconds <= 86400
    : presets.some((preset) => preset.seconds === form.intervalSeconds && preset.seconds >= 300 && preset.seconds <= 3600);

  return <>
    <div className="page-heading">
      <div><p className="eyebrow">MONITORING</p><h1>Monitors</h1><p className="muted">Every endpoint under watch, in one place.</p></div>
      <button className="primary-button" onClick={openCreate}><Plus size={16}/> Add monitor</button>
    </div>
    <div className="toolbar">
      <div className="search-box"><Search size={16}/><input placeholder="Search monitors or URLs" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && void load()}/></div>
      <div className="filter-tabs">{['all', 'up', 'down', 'paused', 'pending'].map((value) => <button className={filter === value ? 'selected' : ''} onClick={() => setFilter(value)} key={value}>{value === 'all' ? 'All' : value[0].toUpperCase() + value.slice(1)}</button>)}</div>
    </div>
    {error && !modal && <div className="error-banner">{error}</div>}
    {notice && <div className="success-banner">{notice}</div>}
    <section className="panel table-panel">
      <div className="table-head"><span>MONITOR</span><span>STATUS</span><span>LAST RESPONSE</span><span>LAST CHECKED</span><span>ACTIONS</span></div>
      {items.length ? items.map((monitor) => <div className="table-row" key={monitor._id}>
        <button className="monitor-cell" onClick={() => nav(`/app/monitors/${monitor._id}`)}><i className={`status-dot ${monitor.status}`}/><span><b>{monitor.name}</b><small>{monitor.url}</small></span></button>
        <span><i className={`status-tag ${monitor.status}`}>{monitor.status}</i></span>
        <span className="table-muted">{monitor.lastResponseTimeMs != null ? `${monitor.lastResponseTimeMs} ms` : '—'}</span>
        <span className="table-muted">{monitor.lastCheckedAt ? new Date(monitor.lastCheckedAt).toLocaleString() : 'Never'}</span>
        <span className="action-row">
          <button title="Check now" disabled={checking === monitor._id || monitor.status === 'paused'} onClick={() => void checkNow(monitor)}>{checking === monitor._id ? <Loader2 size={15} className="spin"/> : <Activity size={15}/>}</button>
          <button title="Edit monitor" onClick={() => openEdit(monitor)}><Pencil size={15}/></button>
          <button title={monitor.status === 'paused' ? 'Resume' : 'Pause'} onClick={() => void action(monitor, monitor.status === 'paused' ? 'resume' : 'pause')}>{monitor.status === 'paused' ? <Play size={15}/> : <Pause size={15}/>}</button>
          <button title="Delete" onClick={() => void action(monitor, 'delete')}><Trash2 size={15}/></button>
        </span>
      </div>) : <div className="empty-state"><div className="empty-icon"><Search/></div><h3>No monitors found</h3><p>{search ? 'Try a different search.' : 'Add an endpoint to begin monitoring.'}</p><button className="primary-button" onClick={openCreate}><Plus size={15}/> Add monitor</button></div>}
    </section>

    {modal && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setModal(false)}>
      <form className="modal" onSubmit={save}>
        <div className="modal-heading"><div><p className="eyebrow">{editingId ? 'MONITOR SETTINGS' : 'NEW ENDPOINT'}</p><h2>{editingId ? 'Edit monitor' : 'Add a monitor'}</h2></div><button type="button" className="icon-button" onClick={() => setModal(false)} aria-label="Close"><X/></button></div>
        <div className="form-grid">
          <label>Monitor name<input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Production API"/></label>
          <label>HTTP method<select value={form.method} onChange={(event) => setForm({ ...form, method: event.target.value })}>{['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((method) => <option key={method}>{method}</option>)}</select></label>
          <label className="form-span-two">Endpoint URL<input required type="url" value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} placeholder="https://api.example.com/health"/></label>
          <label>Check interval
            <select value={intervalChoice} onChange={(event) => {
              const value = event.target.value;
              setIntervalChoice(value);
              if (value !== 'custom') setInterval(Number(value));
            }}>
              {availablePresets.map((preset) => <option value={preset.seconds} key={preset.seconds}>{preset.label}</option>)}
              {isPro && <option value="custom">Custom interval…</option>}
            </select>
            <small>{isPro ? 'Pro supports 1 minute to 1 day.' : 'Free checks run no more often than every 5 minutes.'}</small>
          </label>
          <label>Request timeout<input type="number" min="1000" max="60000" value={form.timeoutMs} onChange={(event) => setForm({ ...form, timeoutMs: Number(event.target.value) })}/><small>Milliseconds (1,000–60,000)</small></label>
          {isPro && intervalChoice === 'custom' && <div className="custom-interval-field">
            <label>Custom duration<input type="number" min="1" step="1" value={customValue} onChange={(event) => changeCustomInterval(Number(event.target.value), customUnit)}/></label>
            <label>Unit<select value={customUnit} onChange={(event) => changeCustomInterval(customValue, event.target.value as IntervalUnit)}>{Object.keys(unitSeconds).map((unit) => <option key={unit} value={unit}>{unit}</option>)}</select></label>
            <small className="form-span-two">Minimum: 60 seconds · Maximum: 1 day. The scheduler stores and runs this interval in seconds.</small>
          </div>}
          <label className="form-span-two">Expected HTTP status codes<input value={form.expectedStatusCodes.join(',')} onChange={(event) => setForm({ ...form, expectedStatusCodes: event.target.value.split(',').map((value: string) => value.trim()) })}/><small>For example: 200-299 or 200, 204</small></label>
          <label className="check-label"><input type="checkbox" checked={form.coldStartAware} onChange={(event) => setForm({ ...form, coldStartAware: event.target.checked })}/><span>Detect cold starts <small>Recommended for services that may sleep.</small></span></label>
          <label className="check-label"><input type="checkbox" checked={form.showOnStatusPage} onChange={(event) => setForm({ ...form, showOnStatusPage: event.target.checked })}/><span>Show on public status page <small>Only applies when a Pro status page is enabled.</small></span></label>
        </div>
        {error && <div className="error-banner">{error}</div>}
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setModal(false)}>Cancel</button><button className="primary-button" disabled={busy || !intervalIsValid}>{busy ? 'Saving…' : editingId ? 'Save changes' : 'Create monitor'}</button></div>
      </form>
    </div>}
  </>;
}
