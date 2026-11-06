import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, ChevronDown, ChevronUp, CircleAlert, GitBranch, MessageSquare, ShieldCheck, Target } from 'lucide-react';
import { dateLabel, displayDate } from './lib.js';
import './daily.css';

const EVIDENCE_LABELS = {
  report: 'Agent report',
  note: 'Progress note',
  observation: 'Observed activity',
  review: 'Reviewed completion',
  goal: 'Goal record',
};

function Time({ value, timeZone, full = false }) {
  return <time dateTime={value || undefined}>{displayDate(value, { timeZone, ...(full ? { month: 'short', day: 'numeric' } : {}), hour: 'numeric', minute: '2-digit' })}</time>;
}

export function ExpandableRecords({ items, children, label, limit = 4, resetKey = '', className = '' }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  useEffect(() => setExpanded(false), [resetKey]);
  return <>
    <ul id={id} className={`daily-records ${className}`}>{(expanded ? items : items.slice(0, limit)).map(children)}</ul>
    {items.length > limit && <div className="daily-expand"><span>{expanded ? items.length : limit} of {items.length} {label}</span><button className="text-button" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : `Show all ${items.length}`}{expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button></div>}
  </>;
}

function PanelHeading({ title, count, context, icon: Icon }) {
  return <div className="panel-heading daily-panel-heading"><div><div className="heading-with-dot">{Icon && <Icon size={15} aria-hidden="true" />}<h2>{title}</h2><span className="count-pill">{count}</span></div><p>{context}</p></div></div>;
}

function Quiet({ children }) {
  return <p className="daily-empty">{children}</p>;
}

function RecordText({ text, recordId, className = '' }) {
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  const paragraph = useRef(null);
  const id = useId();
  useLayoutEffect(() => setExpanded(false), [recordId, text]);
  useLayoutEffect(() => {
    if (expanded || !paragraph.current) return;
    const node = paragraph.current;
    const measure = () => setClipped(node.scrollHeight > node.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [expanded, recordId, text, className]);
  return <div className="daily-record-text">
    <p ref={paragraph} id={id} className={`daily-text ${className} ${expanded ? 'daily-text-expanded' : ''}`}>{text}</p>
    {(clipped || expanded) && <button type="button" className="text-button daily-text-disclosure" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less text' : 'Read full record'}{expanded ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}</button>}
  </div>;
}

export function DailyRequests({ requests, selectedDate, timeZone, query, onSelectTask, onSelectGoal }) {
  return <section className="panel daily-panel" data-testid="daily-requests">
    <PanelHeading title="What you asked" count={requests.length} context={`${dateLabel(selectedDate, { month: 'short' })} · Requests linked to project goals`} icon={MessageSquare} />
    <ExpandableRecords items={requests} label="requests" resetKey={`${selectedDate}:${query}`}>{(request) => <li key={request.id} className="daily-record">
      <div className="daily-record-meta"><span>Your request</span><Time value={request.createdAt} timeZone={timeZone} /></div>
      <RecordText text={request.text} recordId={request.id} className="request-text" />
      <div className="daily-links">{request.goals.map((work) => <button key={work.id} className="text-button daily-goal-link" onClick={() => onSelectGoal(work.id)}><Target size={12} /><span>{work.title}</span></button>)}</div>
      {request.taskId && <button className="text-button daily-detail-link" onClick={() => onSelectTask(request.taskId)}>Open request <ArrowUpRight size={13} /></button>}
    </li>}</ExpandableRecords>
    {!requests.length && <Quiet>{query ? 'No linked requests match your search on this day.' : 'No goal-linked requests recorded for this day. Everyday questions stay in the conversation.'}</Quiet>}
    <p className="daily-footnote">Only recorded links are shown. Older work may have no original request attached.</p>
  </section>;
}

export function DailyProgress({ progress, snapshot, selectedDate, timeZone, query, onSelectTask, onSelectGoal }) {
  return <section className="panel daily-panel" data-testid="daily-progress">
    <PanelHeading title="What changed" count={progress.length} context={`${dateLabel(selectedDate, { month: 'short' })} · ${timeZone.replaceAll('_', ' ')}`} icon={ShieldCheck} />
    <ExpandableRecords items={progress} label="records" resetKey={`${selectedDate}:${query}`}>{(record) => {
      const work = snapshot.workItems.find((item) => item.id === record.workId);
      const task = snapshot.tasks.find((item) => item.id === record.taskId);
      return <li key={record.id} className="daily-record">
        <div className="daily-record-meta"><span className={`daily-evidence daily-evidence-${record.kind}`}>{record.kind === 'report' && task?.status !== 'completed' ? 'Run outcome' : EVIDENCE_LABELS[record.kind] || 'Recorded activity'}</span><Time value={record.createdAt} timeZone={timeZone} /></div>
        <h3 className="daily-record-title">{record.label}</h3>
        {record.text && <RecordText text={record.text} recordId={record.id} />}
        <div className="daily-links">{work && <button className="text-button daily-goal-link" onClick={() => onSelectGoal(work.id)}><Target size={12} /><span>{work.title}</span></button>}{task && <button className="text-button" onClick={() => onSelectTask(task.id)}>Inspect run <ArrowUpRight size={13} /></button>}</div>
      </li>;
    }}</ExpandableRecords>
    {!progress.length && <Quiet>{query ? 'No progress records match your search on this day.' : 'No project progress recorded for this day. Ongoing goals and assignments remain above.'}</Quiet>}
    <p className="daily-footnote">Agent reports and observed activity are evidence to inspect. Only an explicit goal review records completion. Older work may lack a review receipt.</p>
  </section>;
}

export function CurrentAssignments({ assignments, timeZone, query, onSelectTask, onSelectGoal, Status }) {
  return <section className="panel daily-panel assignment-panel" data-testid="current-assignments">
    <PanelHeading title="Who is working" count={assignments.length} context="Current assignments · across all dates" icon={GitBranch} />
    <ExpandableRecords items={assignments} label="assignments" limit={3} resetKey={query}>{(assignment) => {
      const { task, work, project, parent, provider, role, permissionMode, state, summary, step } = assignment;
      return <li key={task.id} className="daily-record assignment-record">
        <div className="assignment-heading"><button className="assignment-title" onClick={() => onSelectTask(task.id)}>{task.title || 'Untitled assignment'}<ArrowUpRight size={13} /></button><Status value={state || 'unknown'} /></div>
        <dl className="assignment-facts"><div><dt>Role / provider</dt><dd>{role || 'Unknown role'} · {provider || 'Unknown provider'}</dd></div><div><dt>Saved access</dt><dd>{permissionMode || 'Unknown'}</dd></div><div><dt>Project</dt><dd>{project?.name || (work ? 'Unknown project' : 'No project assigned')}</dd></div></dl>
        {work ? <button className="text-button daily-goal-link" onClick={() => onSelectGoal(work.id)}><Target size={12} /><span>{work.title}</span></button> : <p className="assignment-unassigned">No recorded goal assignment</p>}
        <div className="assignment-parent"><span>Parent</span>{parent ? <button className="text-button" onClick={() => onSelectTask(parent.id)}>{parent.title || 'Open parent request'}<ArrowUpRight size={12} /></button> : <span>{task.parentTaskId ? 'Unknown · parent record unavailable' : 'No parent recorded'}</span>}</div>
        {step && <p className="assignment-step">Plan step: {step.title || step.id}</p>}
        {summary && <div className="assignment-checkpoint"><span>{task.error ? 'Recorded error' : task.checkpoint?.summary ? task.checkpoint.source === 'system_recovery' ? 'Recovery checkpoint' : 'Agent checkpoint' : task.result ? 'Agent report so far' : 'Queue update'}</span><p className="daily-text assignment-summary">{summary}</p></div>}
        <div className="daily-record-meta assignment-footer"><span>Assigned <Time value={task.createdAt} timeZone={timeZone} full /></span><button className="text-button" onClick={() => onSelectTask(task.id)}>Inspect assignment <ArrowRight size={13} /></button></div>
      </li>;
    }}</ExpandableRecords>
    {!assignments.length && <Quiet>{query ? 'No current assignments match your search.' : 'No Relay assignments are running, queued or waiting. Continue a goal in the master conversation.'}</Quiet>}
    <p className="daily-footnote">Relay-owned runs only. External chat activity is unknown; missing roles, links and saved permissions are never inferred.</p>
  </section>;
}

export function AttentionPanel({ goals, query, onSelectGoal, navigate }) {
  if (!goals.length) return null;
  return <section className="panel daily-attention" data-testid="daily-attention"><div className="panel-heading"><div className="heading-with-dot"><CircleAlert size={15} /><h2>What needs you</h2><span className="count-pill">{goals.length}</span></div><button className="text-button" onClick={() => navigate('needs_you')}>All attention <ArrowRight size={13} /></button></div>
    <ExpandableRecords items={goals} label="goals" limit={3} resetKey={query}>{(work) => <li key={work.id}><button className="attention-goal" onClick={() => onSelectGoal(work.id)}><span><strong>{work.title}</strong><span>{work.nextAction || (work.recoveryRequired ? 'Review recovery before resuming work.' : work.status === 'needs_review' ? 'Inspect the evidence and review this goal.' : 'Open the goal to resolve its blocker.')}</span></span><span className="attention-reason">{work.recoveryRequired ? 'Recovery review' : work.status === 'needs_review' ? 'Review needed' : 'Blocked'}<ArrowUpRight size={13} /></span></button></li>}</ExpandableRecords>
  </section>;
}
