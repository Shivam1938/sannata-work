import { useEffect, useState } from 'react';
import { Activity, AlertTriangle, BarChart3, CheckCircle2, Clock3, RefreshCw, Server, Zap } from 'lucide-react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { api, message } from '../api';
import { useApp } from '../App';

type Range = '24h' | '7d' | '30d';
type Tab = 'analytics' | 'realtime' | 'performance' | 'endpoints' | 'errors';
const COLORS = ['#84cc16', '#38bdf8', '#f59e0b', '#f87171', '#94a3b8'];

export default function Analytics({ initialTab = 'analytics' }: { initialTab?: Tab }) {
  const { user } = useApp();
  const [range, setRange] = useState<Range>('24h');
  const [tab, setTab] = useState<Tab>(initialTab);
  useEffect(() => { setTab(initialTab); }, [initialTab]);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true);
    try {
      const response = await api.get('/api/analytics', { params: { range } });
      setData(response.data);
      setError('');
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, [range]);
  const summary = data?.summary || {};
  const isPro = user?.plan === 'pro';
  const rangeOptions: Range[] = isPro ? ['24h', '7d', '30d'] : ['24h', '7d'];

  return <>
    <div className="page-heading">
      <div><p className="eyebrow">OBSERVABILITY</p><h1>Analytics</h1><p className="muted">Monitoring activity and endpoint performance from your saved checks.</p></div>
      <button className="secondary-button" onClick={load} disabled={loading}><RefreshCw size={15} className={loading ? 'spin' : ''}/> Refresh data</button>
    </div>
    {error && <div className="error-banner">{error}</div>}
    <div className="panel-heading analytics-toolbar">
      <div className="filter-tabs">{(['analytics', 'realtime', 'performance', 'endpoints', 'errors'] as Tab[]).map((item) =>
        <button key={item} className={tab === item ? 'selected' : ''} onClick={() => setTab(item)}>{item[0].toUpperCase() + item.slice(1)}</button>
      )}</div>
      <div className="filter-tabs">{rangeOptions.map((item) =>
        <button key={item} className={range === item ? 'selected' : ''} onClick={() => setRange(item)}>{item}</button>
      )}</div>
    </div>
    <div className="metric-grid">
      {[
        [BarChart3, 'Total checks', summary.totalChecks ?? '—', 'Monitoring attempts in selected range'],
        [Clock3, 'Average latency', summary.avgResponseTimeMs == null ? '—' : `${summary.avgResponseTimeMs} ms`, 'Successful checks, cold starts excluded'],
        [AlertTriangle, 'Error rate', summary.errorRate == null ? '—' : `${summary.errorRate}%`, 'Failed monitoring attempts'],
        [CheckCircle2, 'Success rate', summary.successRate == null ? '—' : `${summary.successRate}%`, 'Successful monitoring attempts'],
        [Server, 'Unique services', summary.uniqueServices ?? '—', 'Distinct hostnames being monitored'],
        [Zap, 'Endpoints', summary.uniqueEndpoints ?? '—', 'Configured monitors'],
      ].map(([Icon, label, value, caption]: any) => <div className="metric-card" key={label}>
        <div className="metric-icon green"><Icon size={18}/></div><span>{label}</span><strong>{value}</strong><small>{caption}</small>
      </div>)}
    </div>

    {(tab === 'analytics' || tab === 'performance') && <div className="analytics-chart-grid">
      <section className="panel chart-panel">
        <div className="panel-heading"><div><h3>Monitoring activity</h3><p>Checks recorded over time · not raw API traffic</p></div></div>
        <div className="chart-area analytics-chart"><ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data?.traffic || []}>
            <defs>
              <linearGradient id="checkSuccess" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#84cc16" stopOpacity={0.28}/><stop offset="95%" stopColor="#84cc16" stopOpacity={0}/></linearGradient>
              <linearGradient id="checkFailed" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#f87171" stopOpacity={0.2}/><stop offset="95%" stopColor="#f87171" stopOpacity={0}/></linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--line)"/>
            <XAxis dataKey="label" tick={{fill:'var(--muted)',fontSize:11}}/>
            <YAxis allowDecimals={false} tick={{fill:'var(--muted)',fontSize:11}}/>
            <Tooltip contentStyle={{background:'var(--panel)',border:'1px solid var(--line)',borderRadius:10}}/>
            <Area type="monotone" dataKey="success" name="Successful checks" stroke="#84cc16" fill="url(#checkSuccess)"/>
            <Area type="monotone" dataKey="failed" name="Failed checks" stroke="#f87171" fill="url(#checkFailed)"/>
          </AreaChart>
        </ResponsiveContainer></div>
      </section>
      <section className="panel chart-panel">
        <div className="panel-heading"><div><h3>Status code distribution</h3><p>HTTP response groups across monitoring checks</p></div></div>
        <div className="chart-area analytics-chart">
          {data?.statusDistribution?.length ? <ResponsiveContainer width="100%" height="100%">
            <PieChart><Pie data={data.statusDistribution} dataKey="value" nameKey="name" innerRadius="54%" outerRadius="78%" paddingAngle={3}>
              {data.statusDistribution.map((_: any, i: number) => <Cell key={i} fill={COLORS[i % COLORS.length]}/>)}
            </Pie><Tooltip contentStyle={{background:'var(--panel)',border:'1px solid var(--line)',borderRadius:10}}/></PieChart>
          </ResponsiveContainer> : <div className="chart-empty">No status-code data yet. Run a manual check or wait for the next scheduled check.</div>}
        </div>
        <div className="analytics-legend">{(data?.statusDistribution || []).map((item: any, i: number) => <span key={item.name}><i style={{background:COLORS[i % COLORS.length]}}/>{item.name}: {item.value}</span>)}</div>
      </section>
    </div>}

    {(tab === 'analytics' || tab === 'endpoints' || tab === 'performance') && <section className="panel table-panel analytics-table">
      <div className="panel-heading"><div><h3>{tab === 'performance' ? 'Endpoint performance' : 'Top endpoints'}</h3><p>Ranked by recorded monitoring checks in this range</p></div></div>
      <div className="table-head analytics-endpoint-head"><span>ENDPOINT</span><span>METHOD</span><span>CHECKS</span><span>AVG LATENCY</span><span>ERROR RATE</span></div>
      {(data?.topEndpoints || []).length ? data.topEndpoints.map((m: any) => <div className="table-row analytics-endpoint-row" key={m.monitorId}>
        <span className="analytics-endpoint-name"><b>{m.name}</b><small>{m.url}</small></span><span>{m.method}</span><span>{m.hits}</span><span>{m.avgLatencyMs == null ? '—' : `${m.avgLatencyMs} ms`}</span><span className={m.errorRate > 0 ? 'text-danger' : 'text-success'}>{m.errorRate}%</span>
      </div>) : <div className="empty-small">No checks recorded in this range.</div>}
    </section>}

    {tab === 'realtime' && <section className="panel table-panel analytics-table">
      <div className="panel-heading"><div><h3>Recent monitoring checks</h3><p>Latest saved endpoint checks · refresh to fetch the newest results</p></div><button className="subtle-button" onClick={load} disabled={loading}><RefreshCw size={14}/> Refresh</button></div>
      <div className="table-head analytics-error-head"><span>ENDPOINT</span><span>RESULT</span><span>STATUS</span><span>RESPONSE</span><span>CHECKED AT</span></div>
      {(data?.recentChecks || []).length ? data.recentChecks.map((c: any, i: number) => <div className="table-row analytics-error-row" key={`${c.checkedAt}-${i}`}>
        <span className="analytics-endpoint-name"><b>{c.monitorName}</b><small>{c.url}</small></span><span className={c.success ? 'text-success' : 'text-danger'}>{c.success ? 'Success' : 'Failed'}</span><span>{c.statusCode ?? '—'}</span><span>{c.responseTimeMs == null ? '—' : `${c.responseTimeMs} ms`}</span><span>{new Date(c.checkedAt).toLocaleString()}</span>
      </div>) : <div className="empty-small">No checks recorded yet. Run a manual check from a monitor's detail page.</div>}
    </section>}

    {(tab === 'analytics' || tab === 'errors') && <section className="panel table-panel analytics-table">
      <div className="panel-heading"><div><h3>Recent errors</h3><p>Latest failed monitoring attempts</p></div></div>
      <div className="table-head analytics-error-head"><span>ENDPOINT</span><span>ERROR</span><span>STATUS</span><span>RESPONSE</span><span>CHECKED AT</span></div>
      {(data?.errors || []).length ? data.errors.map((e: any, i: number) => <div className="table-row analytics-error-row" key={`${e.checkedAt}-${i}`}>
        <span className="analytics-endpoint-name"><b>{e.monitorName}</b><small>{e.url}</small></span><span>{e.errorType || 'HTTP failure'}</span><span>{e.statusCode ?? '—'}</span><span>{e.responseTimeMs == null ? '—' : `${e.responseTimeMs} ms`}</span><span>{new Date(e.checkedAt).toLocaleString()}</span>
      </div>) : <div className="empty-small">No failed checks in this range. Nice and quiet.</div>}
    </section>}
    <p className="muted analytics-footnote"><Activity size={13}/> These charts use Sannata's monitor-check history. They do not represent every request made by users to the monitored APIs.</p>
  </>;
}
