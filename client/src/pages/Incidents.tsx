import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Sparkles, ChevronDown, ChevronUp, ShieldCheck } from 'lucide-react';
import { api } from '../api';

type AnalysisSection = { heading: string; lines: string[] };
function parseAnalysis(value: string): AnalysisSection[] {
  const sections: AnalysisSection[] = [];
  let current: AnalysisSection | null = null;
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(DIAGNOSIS|EVIDENCE|LIKELY CAUSES|RECOMMENDED FIX|VERIFY THE FIX|CONFIDENCE|RESOLUTION|PROBABLE CAUSE|PREVENTION):?\s*(.*)$/i);
    if (match) {
      current = { heading: match[1].toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()), lines: [] };
      sections.push(current);
      if (match[2]) current.lines.push(match[2]);
    } else if (current) {
      current.lines.push(line.replace(/^[-*]\s*/, ''));
    } else {
      current = { heading: 'Analysis', lines: [line] };
      sections.push(current);
    }
  }
  return sections;
}

function IncidentAnalysis({ value, resolved }: { value: string; resolved: boolean }) {
  const sections = parseAnalysis(value);
  const structured = sections.some((s) => ['Diagnosis', 'Evidence', 'Likely Causes', 'Recommended Fix', 'Verify The Fix', 'Resolution', 'Probable Cause', 'Prevention'].includes(s.heading));
  return <div className="ai-analysis">
    <div className="ai-analysis-heading"><span className="ai-sparkle"><Sparkles size={15}/></span><div><b>AI incident analysis</b><small>{resolved ? 'Resolution review' : 'Root-cause investigation'} · Groq</small></div><span className="ai-analysis-pill">AI ANALYSIS</span></div>
    {structured ? <div className="ai-analysis-grid">{sections.map((section, index) => <section className={'ai-analysis-section ' + (section.heading === 'Recommended Fix' ? 'recommended' : '')} key={index}><h4>{section.heading === 'Recommended Fix' ? <ShieldCheck size={14}/> : null}{section.heading}</h4><div>{section.lines.map((line, i) => <p key={i}>{line.replace(/^\d+[.)]\s*/, '')}</p>)}</div></section>)}</div> : <p className="ai-legacy-summary">{value}</p>}
  </div>;
}

export default function Incidents() {
  const [items, setItems] = useState<any[]>([]);
  const [status, setStatus] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  useEffect(() => {
    api.get('/api/incidents', { params: { status: status || undefined } })
      .then((r) => setItems(r.data.incidents))
      .catch(() => setItems([]));
  }, [status]);

  return <>
    <div className="page-heading"><div><p className="eyebrow">EVENT LOG</p><h1>Incidents</h1><p className="muted">Understand what happened, why it may have happened, and how to fix it.</p></div></div>
    <div className="toolbar"><div className="filter-tabs">{[['', 'All incidents'], ['open', 'Open'], ['resolved', 'Resolved']].map(([v, l]) => <button key={v} className={status === v ? 'selected' : ''} onClick={() => setStatus(v)}>{l}</button>)}</div></div>
    <section className="panel table-panel">{items.length ? items.map((i) => {
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
          <button className="incident-expand" onClick={() => setExpanded(isExpanded ? null : id)}>{isExpanded ? <ChevronUp size={16}/> : <ChevronDown size={16}/>}<span>{isExpanded ? 'Hide analysis' : 'View analysis'}</span></button>
        </div>
        {isExpanded && <div className="incident-details">{analysis ? <IncidentAnalysis value={analysis} resolved={i.status === 'resolved'}/> : <div className="ai-pending"><Sparkles size={16}/><div><b>AI analysis is not available yet</b><p>This incident may have been created before Groq was configured, or the AI request failed. New incidents will use the updated analysis format.</p></div></div>}</div>}
      </article>;
    }) : <div className="empty-state"><div className="empty-icon"><CheckCircle2/></div><h3>No incidents here</h3><p>When a monitor needs attention, its incident timeline will appear here.</p></div>}</section>
  </>;
}
