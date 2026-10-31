import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Sparkles, ChevronDown, ChevronUp, ShieldCheck, Activity, ClipboardCheck, Search, Wrench, LockKeyhole, ArrowUpRight } from 'lucide-react';
import { api, message } from '../api';
import { useApp } from '../App';
import { useNavigate } from 'react-router-dom';

type AnalysisSection = { heading: string; lines: string[] };
function parseAnalysis(value: string): AnalysisSection[] {
  const sections: AnalysisSection[] = [];
  let current: AnalysisSection | null = null;
  const aliases: Record<string, string> = {
    'EXECUTIVE DIAGNOSIS': 'Diagnosis', 'WHAT THE CHECKS SHOW': 'Evidence',
    'PROBABLE ROOT CAUSES': 'Likely Causes', 'RECOMMENDED REMEDIATION': 'Recommended Fix',
    'HOW TO VERIFY RECOVERY': 'Verify The Fix',
    'INCIDENT OUTCOME': 'Resolution', 'CONFIRMED TIMELINE AND EVIDENCE': 'Evidence',
    'PROBABLE CAUSE': 'Probable Cause', 'PREVENTION ACTIONS': 'Prevention',
    'DIAGNOSIS': 'Diagnosis', 'EVIDENCE': 'Evidence', 'LIKELY CAUSES': 'Likely Causes',
    'RECOMMENDED FIX': 'Recommended Fix', 'VERIFY THE FIX': 'Verify The Fix',
    'RESOLUTION': 'Resolution', 'PREVENTION': 'Prevention',
    'INCIDENT SUMMARY': 'Incident Summary', 'SEVERITY AND IMPACT': 'Severity & Impact',
    'CONFIRMED EVIDENCE': 'Confirmed Evidence', 'ROOT CAUSE ANALYSIS': 'Root Cause Analysis',
    'LIKELY TECHNICAL CAUSES': 'Likely Technical Causes',
    'RECOMMENDED RESOLUTION': 'Recommended Resolution',
    'VERIFICATION CHECKLIST': 'Verification Checklist',
    'PREVENTION RECOMMENDATIONS': 'Prevention Recommendations',
    'CONFIDENCE': 'Confidence',
  };
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = line.replace(/^#{1,3}\s*/, '').replace(/:$/, '').toUpperCase();
    if (aliases[heading]) {
      current = { heading: aliases[heading], lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line.replace(/^[-*]\s*/, '').replace(/^\d+[.)]\s*/, ''));
    } else {
      current = { heading: 'Analysis', lines: [line] };
      sections.push(current);
    }
  }
  return sections;
}

function IncidentAnalysis({ value, resolved }: { value: string; resolved: boolean }) {
  const sections = parseAnalysis(value);
  const structured = sections.some((s) => !['Analysis'].includes(s.heading));
  const iconFor = (heading: string) => {
    if (heading.includes('Summary') || heading === 'Diagnosis' || heading === 'Resolution') return <Activity size={15}/>;
    if (heading.includes('Evidence')) return <ClipboardCheck size={15}/>;
    if (heading.includes('Cause') || heading === 'Probable Cause') return <Search size={15}/>;
    if (heading.includes('Resolution') || heading.includes('Prevention') || heading === 'Recommended Fix') return <Wrench size={15}/>;
    if (heading.includes('Checklist') || heading === 'Verify The Fix') return <ShieldCheck size={15}/>;
    return <Sparkles size={15}/>;
  };
  return <div className="ai-analysis">
    <div className="ai-analysis-heading"><span className="ai-sparkle"><Sparkles size={17}/></span><div><b>AI incident analysis</b><small>{resolved ? 'Recovery review · Evidence-based post-mortem' : 'Root-cause investigation · Actionable remediation'}</small></div><span className="ai-analysis-pill">EVIDENCE-BASED</span></div>
    {structured ? <div className="ai-analysis-grid">{sections.map((section, index) => <section className={'ai-analysis-section ' + (section.heading === 'Recommended Fix' ? 'recommended' : '')} key={index}><h4>{iconFor(section.heading)}{section.heading}</h4><div>{section.lines.map((line, i) => <p key={i}>{line.replace(/^\d+[.)]\s*/, '')}</p>)}</div></section>)}</div> : <div className="ai-legacy-summary">{value}</div>}
    <p className="ai-analysis-disclaimer">Analysis is based on recorded monitor checks. Validate suggested changes in your own environment before applying them.</p>
  </div>;
}

export default function Incidents() {
  const [items, setItems] = useState<any[]>([]);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const { user, refresh } = useApp();
  const navigate = useNavigate();
  const [analysisLoading, setAnalysisLoading] = useState<string | null>(null);
  const [analysisErrors, setAnalysisErrors] = useState<Record<string, string>>({});
  const freeAiUsed = user?.plan !== 'pro' && Number((user as any)?.aiAnalysesUsed || 0) >= 1;
  useEffect(() => {
    setLoading(true);
    setAnalysisErrors((current) => ({ ...current, list: '' }));
    api.get('/api/incidents', { params: { status: status || undefined } })
      .then((r) => setItems(r.data.incidents))
      .catch((e) => {
        setItems([]);
        setAnalysisErrors((current) => ({ ...current, list: e?.response?.data?.error?.message || e?.message || 'Unable to load incidents.' }));
      })
      .finally(() => setLoading(false));
  }, [status]);

  const runAnalysis = async (incident: any) => {
    const id = String(incident._id);
    setAnalysisLoading(id);
    setAnalysisErrors((current) => ({ ...current, [id]: '' }));
    try {
      const { data } = await api.post(`/api/incidents/${id}/analyze`);
      setItems((current) => current.map((item) => item._id === incident._id
        ? { ...item, ...(item.status === 'resolved' ? { aiSummaryResolved: data.analysis } : { aiSummary: data.analysis }) }
        : item));
      await refresh();
    } catch (error) {
      setAnalysisErrors((current) => ({ ...current, [id]: message(error) }));
      await refresh();
    } finally {
      setAnalysisLoading(null);
    }
  };

  return <>
    <div className="page-heading"><div><p className="eyebrow">EVENT LOG</p><h1>Incidents</h1><p className="muted">Understand what happened, why it may have happened, and how to fix it.</p></div></div>
    {analysisErrors.list && <div className="error-banner">{analysisErrors.list}</div>}
    <div className="toolbar"><div className="filter-tabs">{[['', 'All incidents'], ['open', 'Open'], ['resolved', 'Resolved']].map(([v, l]) => <button key={v} className={status === v ? 'selected' : ''} onClick={() => setStatus(v)}>{l}</button>)}</div></div>
    <section className="panel table-panel">{loading ? <div className="empty-small">Loading incidents…</div> : items.length ? items.map((i) => {
      const id = String(i._id);
      const isExpanded = expanded === id;
      const analysis = i.status === 'resolved' ? (i.aiSummaryResolved || i.aiSummary) : i.aiSummary;
      return <article className="incident-entry" key={id}>
        <div className="incident-row">
          <div className={'incident-icon ' + i.status}>{i.status === 'open' ? <AlertTriangle size={18}/> : <CheckCircle2 size={18}/>}</div>
          <div className="incident-copy"><div><b>{i.firstErrorType || 'Monitor incident'}</b><span className={'status-tag ' + i.status}>{i.status}</span></div>
            <p>{i.lastErrorMessage || (analysis ? 'AI analysis available.' : 'Waiting for incident details.')}</p>
            <small>Started {new Date(i.startedAt).toLocaleString()} {i.resolvedAt ? ' · Resolved ' + new Date(i.resolvedAt).toLocaleString() : ''}</small>
          </div>
          <div className="incident-duration"><Clock size={14}/>{i.durationSeconds ? `${Math.round(i.durationSeconds / 60)} min` : 'Ongoing'}</div>
          <button className="incident-expand" disabled={analysisLoading === id} onClick={() => {
            if (isExpanded) setExpanded(null);
            else {
              setExpanded(id);
              if (!freeAiUsed || user?.plan === 'pro') void runAnalysis(i);
            }
          }}>{analysisLoading === id ? <Activity size={16} className="spin"/> : isExpanded ? <ChevronUp size={16}/> : <ChevronDown size={16}/>}<span>AI Analysis</span></button>
        </div>
        {isExpanded && <div className="incident-details">{analysis ? <IncidentAnalysis value={analysis} resolved={i.status === 'resolved'}/> : analysisLoading === id ? <div className="ai-pending"><Sparkles size={16}/><div><b>Generating evidence-based analysis…</b><p>Reviewing the incident and saved monitoring results. This may take a few seconds.</p></div></div> : freeAiUsed ? <div className="ai-upgrade-prompt"><span><LockKeyhole size={18}/></span><div><b>You've used your free AI analysis. Buy Pro for more analysis.</b><p>Further AI analysis is disabled on Free. Upgrade your plan to continue.</p><button onClick={()=>navigate('/app/pricing')}>Explore Pro <ArrowUpRight size={14}/></button></div></div> : <div className="ai-pending"><Sparkles size={16}/><div><b>{analysisErrors[id] || 'AI analysis is not available yet.'}</b><p>{analysisErrors[id] ? 'The analysis was not stored. Check the message above and retry when ready.' : 'The report uses this incident and its actual saved checks. It does not invent server logs or infrastructure details.'}</p><button className="secondary-button" onClick={() => void runAnalysis(i)}>Retry AI Analysis</button></div></div>}</div>}
      </article>;
    }) : <div className="empty-state"><div className="empty-icon"><CheckCircle2/></div><h3>No incidents here</h3><p>When a monitor needs attention, its incident timeline will appear here.</p></div>}</section>
  </>;
}
