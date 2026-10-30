import { Check, X, ArrowUpRight, Sparkles, CalendarClock, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { api, message } from '../api';
import { useApp } from '../App';

const formatExpiry = (value?: string | null) => value
  ? new Date(value).toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' })
  : 'Not scheduled';

type Feature = { label: string; free: boolean; pro: boolean };
const features: Feature[] = [
  { label: 'Monitors to watch', free: true, pro: true },
  { label: 'Check interval', free: true, pro: true },
  { label: 'Check history', free: true, pro: true },
  { label: 'Email & Telegram outage alerts', free: true, pro: true },
  { label: 'AI incident analysis', free: true, pro: true },
  { label: 'Public status page', free: false, pro: true },
  { label: 'Custom status page branding', free: false, pro: true },
  { label: 'Priority monitoring checks', free: false, pro: true },
  { label: 'Higher request tester limit', free: false, pro: true },
];

export default function Pricing() {
  const { user, refresh } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const isPro = user?.plan === 'pro' && (!user.proExpiresAt || new Date(user.proExpiresAt).getTime() > Date.now());
  const freeAiUsed = Number((user as any)?.aiAnalysesUsed || 0) >= 1;

  const upgrade = async () => {
    if (!window.confirm('Activate Sannata Pro for 30 days? This is a demo upgrade; no payment will be taken.')) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const { data } = await api.post('/api/plan/upgrade');
      await refresh();
      setNotice(data.message || 'Pro activated for 30 days.');
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  };

  return <>
    <div className="page-heading centered-heading"><div><p className="eyebrow">SIMPLE, HONEST PRICING</p><h1>Start free. Upgrade when you need more.</h1><p className="muted">The essentials are free. Pro unlocks the tools to run services with confidence.</p></div></div>
    {error && <div className="error-banner">{error}</div>}
    {notice && <div className="success-banner"><ShieldCheck size={15}/>{notice}</div>}
    {isPro && <section className="panel subscription-active"><div><span className="status-tag up">PRO ACTIVE</span><h2>Your workspace is on Pro.</h2><p className="muted">All Pro limits and features are enabled for this account.</p></div><div className="subscription-expiry"><CalendarClock size={18}/><span><small>Expires on</small><b>{formatExpiry(user?.proExpiresAt)}</b></span></div></section>}
    <div className="pricing-grid">
      <div className="panel price-card"><span className="eyebrow">FOR PERSONAL PROJECTS</span><h2>Free</h2><div className="price">₹0 <small>/ forever</small></div><p className="muted">Start monitoring your APIs with the essentials.</p>
        <ul className="plan-feature-list">
          <li><Check/>5 monitors</li><li><Check/>5-minute minimum checks</li><li><Check/>7-day check history</li><li><Check/>Email & Telegram alerts</li><li><Check/>{freeAiUsed ? '1 AI analysis used' : '1 AI incident analysis (one-time)'}</li>
          <li className="unavailable"><X/>Public status page</li><li className="unavailable"><X/>Custom status page branding</li><li className="unavailable"><X/>Priority monitoring checks</li><li><Check/>30 request tester calls/minute</li>
        </ul>
        {!isPro ? <button className="secondary-button full" disabled>Your current plan</button> : <div className="plan-note">Free plan features are included with Pro.</div>}
      </div>
      <div className="panel price-card featured"><span className="popular-tag"><Sparkles size={13}/> BUILT FOR GROWING APIS</span><span className="eyebrow">FOR DEVELOPERS & TEAMS</span><h2>Pro</h2><div className="price">₹199 <small>/ month</small></div><p className="muted">More coverage, deeper insight, and a public face for your uptime.</p>
        <ul className="plan-feature-list">
          <li><Check/>50 monitors</li><li><Check/>1-minute minimum checks</li><li><Check/>30-day check history</li><li><Check/>Email & Telegram alerts</li><li><Check/>Unlimited AI incident analysis</li><li><Check/>Public status page with shareable URL</li><li><Check/>Custom status page title & branding</li><li><Check/>Priority monitoring checks</li><li><Check/>120 request tester calls/minute</li>
        </ul>
        {isPro ? <button className="secondary-button full" disabled><ShieldCheck size={15}/> Your Pro plan is active</button> : <button className="primary-button full" onClick={upgrade} disabled={busy}>{busy?'Activating…':'Upgrade to Pro'} <ArrowUpRight size={15}/></button>}
        <small className="demo-note">Demo upgrade only. No payment taken when DEMO_MODE=true. Access lasts 30 days.</small>
      </div>
    </div>
    <section className="panel plan-comparison"><div><p className="eyebrow">AT A GLANCE</p><h3>What changes with Pro?</h3><p className="muted">A clear comparison—no hidden feature names.</p></div><div className="comparison-table"><div className="comparison-head"><span>Feature</span><b>Free</b><b>Pro</b></div>{features.map((f)=><div className="comparison-row" key={f.label}><span>{f.label}</span><span>{f.free?<Check className="feature-yes"/>:<X className="feature-no"/>}</span><span>{f.pro?<Check className="feature-yes"/>:<X className="feature-no"/>}</span></div>)}</div></section>
  </>;
}
