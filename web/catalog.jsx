import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ArrowRight, BookOpen, Check, ChevronRight, CircleAlert, Clock3, FolderKanban, GitBranch, LoaderCircle, MessageSquare, RefreshCw, Search, ShieldCheck, Target } from 'lucide-react';
import { canAutoRefreshCatalog, catalogActivity, filterCatalogThreads, formatCatalogDate, groupCatalogThreads, handoffIdentity } from './catalog-lib.js';
import './catalog.css';

async function catalogApi(path, { body, signal } = {}) {
  const response = await fetch(path, { signal, ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : `Could not load Codex workspace (${response.status}). Try again.`);
  return data;
}

function useCatalog(sample, active) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [olderHistoryLoaded, setOlderHistoryLoaded] = useState(false);
  const request = useRef(null);
  const enabled = useRef(!sample);
  enabled.current = !sample;
  const load = useCallback(async (refresh = false, loadMore = false) => {
    if (!enabled.current || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    try {
      const result = await catalogApi(refresh ? '/api/codex/refresh' : '/api/codex/catalog', { signal: controller.signal, ...(refresh ? { body: { loadMore } } : {}) });
      if (!controller.signal.aborted && enabled.current) {
        setData(result); setError('');
        if (result.available) setOlderHistoryLoaded(loadMore);
      }
    } catch (failure) {
      if (!controller.signal.aborted && enabled.current) setError(failure.message);
    } finally {
      if (request.current === controller) { request.current = null; setBusy(false); }
    }
  }, []);
  useEffect(() => {
    if (sample) { setData(null); setError(''); setBusy(false); setOlderHistoryLoaded(false); return; }
    load();
    return () => { request.current?.abort(); request.current = null; };
  }, [sample, load]);
  useEffect(() => {
    if (sample || !active) return;
    const timer = setInterval(() => {
      if (canAutoRefreshCatalog({ sample, active, visibilityState: document.visibilityState, busy: Boolean(request.current), olderHistoryLoaded })) load(true);
    }, 30000);
    return () => clearInterval(timer);
  }, [sample, active, load, olderHistoryLoaded]);
  return { data: sample ? null : data, busy, error, load, olderHistoryLoaded };
}

function CatalogStatus({ thread }) {
  const status = catalogActivity(thread);
  const Icon = status.state === 'active' ? Activity : status.state === 'idle' ? Check : Clock3;
  return <span className={`catalog-status catalog-status-${status.state}`} title={thread.activity?.basis || status.label}><Icon size={13} aria-hidden="true" />{status.label}</span>;
}

function Notices({ warnings }) {
  if (!warnings?.length) return null;
  return <ul className="catalog-notices">{warnings.map((warning, index) => <li key={index}><CircleAlert size={15} aria-hidden="true" /><span>{typeof warning === 'string' ? warning : warning.message || 'Some Codex records could not be read.'}</span></li>)}</ul>;
}

function MemoryDetails({ Modal, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    catalogApi('/api/codex/memory', { signal: controller.signal }).then(setData).catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [retry]);
  return <Modal title="What Codex remembers" eyebrow="Historical context" onClose={onClose} wide><div className="modal-body catalog-detail">
    <p className="catalog-explainer">Generated memory can help you find your bearings. It can be incomplete or outdated and does not verify that work was completed. Opening it does not send it to an agent.</p>
    {error ? <div className="error-banner" role="alert"><span>{error}</span><button className="text-button" onClick={() => setRetry(value => value + 1)}>Retry</button></div> : !data ? <p role="status"><LoaderCircle size={16} className="spin" /> Reading local memory…</p> : <>
      <p className="catalog-source">Source: {data.source || 'Local Codex memory'}{data.updatedAt && ` · Updated ${formatCatalogDate(data.updatedAt)}`}</p>
      {data.warning && <p className="catalog-notice">{data.warning}</p>}
      {data.available && data.text ? <pre className="catalog-context" tabIndex={0} aria-label="Generated Codex memory">{data.text}</pre> : <p className="catalog-empty-copy">No generated memory is available. Your chats can still be discovered by their project directories.</p>}
      {data.truncated && <p className="catalog-notice">This is a bounded excerpt. The original memory file is unchanged.</p>}
    </>}
  </div><div className="modal-footer"><button className="button secondary" onClick={onClose}>Close</button></div></Modal>;
}

function ThreadDetails({ selected, Modal, onClose, onContinued, onBusyChange }) {
  const [detail, setDetail] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [sendError, setSendError] = useState('');
  const [retry, setRetry] = useState(0);
  const [request, setRequest] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [sending, setSending] = useState(false);
  const submission = useRef(null);
  const sendingRef = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoadError(''); setDetail(null); setReviewed(false); setAcknowledged(false);
    catalogApi(`/api/codex/threads/${encodeURIComponent(selected.id)}`, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) setDetail(result); }).catch(failure => { if (!controller.signal.aborted) setLoadError(failure.message); });
    return () => controller.abort();
  }, [selected.id, retry]);
  const submit = async event => {
    event.preventDefault();
    if (sendingRef.current || !reviewed || !acknowledged || !request.trim() || !detail?.contextHash) return;
    sendingRef.current = true; setSending(true); onBusyChange(true); setSendError('');
    const body = { threadId: selected.id, contextHash: detail.contextHash, request: request.trim() };
    submission.current = handoffIdentity(submission.current, body);
    try {
      const result = await catalogApi('/api/codex/handoff', { body: { ...body, reviewed: true, acknowledgeUncertainActivity: true, requestId: submission.current.requestId } });
      onContinued(result);
    } catch (failure) { setSendError(failure.message); }
    finally { sendingRef.current = false; setSending(false); onBusyChange(false); }
  };
  const thread = detail?.thread || selected;
  return <Modal title={thread.title || 'Untitled Codex chat'} eyebrow="Codex chat · source preserved" onClose={() => { if (!sendingRef.current) onClose(); }} wide><form onSubmit={submit}>
    <div className="modal-body catalog-detail">
      <div className="catalog-detail-meta"><CatalogStatus thread={thread} /><span>{thread.ownership === 'relay' ? 'Relay session' : 'Existing Codex chat'}</span>{thread.archived && <span>Archived</span>}</div>
      <p className="catalog-source">{thread.projectName || 'Unassigned project'} · {thread.workspace || 'No directory recorded'}<br />Last recorded activity: {formatCatalogDate(thread.updatedAt)}<br />Source: {thread.source || 'Codex app server'} · Chat {thread.id}</p>
      {loadError ? <div className="error-banner" role="alert"><span>{loadError}</span><button type="button" className="text-button" onClick={() => setRetry(value => value + 1)}>Retry loading</button></div> : !detail ? <p className="catalog-loading" role="status"><LoaderCircle className="spin" size={18} /> Reading a bounded chat history…</p> : <>
        <Notices warnings={detail.warnings} />
        {detail.summary && <section className="catalog-summary" aria-label="Last recorded exchange"><h3>Where this chat left off</h3><span className="catalog-source">Historical record{detail.summary.lastRecordedStatus ? ` · Last recorded turn: ${detail.summary.lastRecordedStatus}` : ''}</span>{detail.summary.lastRequest && <><strong>You asked</strong><p>{detail.summary.lastRequest}</p></>}{detail.summary.lastResponse && <><strong>Codex reported</strong><p>{detail.summary.lastResponse}</p></>}{!detail.summary.lastRequest && !detail.summary.lastResponse && <p>No recent exchange is available.</p>}</section>}
        <details className="catalog-history"><summary>Recorded turns <span>({detail.turns?.length || 0})</span></summary>{detail.turns?.map((turn, index) => <section key={turn.id || index}><h4>Turn {index + 1} · {turn.status || 'Status not recorded'}</h4><span className="catalog-source">{formatCatalogDate(turn.startedAt || turn.completedAt)}</span>{turn.items?.map((item, itemIndex) => <div className="catalog-history-item" key={itemIndex}><strong>{item.role || item.type}{item.status ? ` · ${item.status}` : ''}</strong>{item.text && <pre>{item.text}</pre>}{item.path && <p>{item.path}</p>}{Number.isFinite(item.exitCode) && <p>Recorded exit code: {item.exitCode}</p>}</div>)}</section>)}</details>
        <section className="catalog-handoff"><h3>Continue in Relay</h3><p className="catalog-explainer">Starts a Relay continuation using this context. Original chat is unchanged. Check that other agents are not editing this project. Project access remains unchanged.</p>
          <div className="catalog-context-heading"><span className="field-label">Exact historical context to include</span><button type="button" className="text-button" disabled={sending} onClick={() => setRetry(value => value + 1)}>Reload context <RefreshCw size={13} /></button></div><pre id="handoff-context" className="catalog-context" tabIndex={0} aria-label="Exact historical context to include">{detail.contextText || 'No historical context is available.'}</pre>
          {detail.truncated && <p className="catalog-notice">History is truncated to a bounded excerpt. Review it for missing context before continuing.</p>}
          <label className="review-check"><input type="checkbox" checked={reviewed} disabled={sending || !detail.contextHash} onChange={event => setReviewed(event.target.checked)} data-testid="handoff-reviewed" /><span>I reviewed this exact context and want to include it with my next request.</span></label>
          <label className="review-check"><input type="checkbox" checked={acknowledged} disabled={sending} onChange={event => setAcknowledged(event.target.checked)} data-testid="handoff-activity-ack" /><span>I checked for other agents working on this project. External live activity may be unknown, and I accept continuing in a separate Relay conversation.</span></label>
          <label className="field-label spaced-label" htmlFor="handoff-request">What should Relay do next?</label><textarea id="handoff-request" className="text-input form-textarea" rows={4} maxLength={6000} placeholder="Pick up the investigation and propose the next useful step…" value={request} disabled={sending} onChange={event => { setRequest(event.target.value); setSendError(''); }} required data-testid="handoff-request" />
          <p className="catalog-source">This adds the reviewed excerpt and your request to the master conversation, alongside its existing work context. A chat does not become a goal unless meaningful project work is identified.</p>
        </section>
      </>}
      {sendError && <div className="error-banner" role="alert"><span>{sendError} Your request is kept here. Retrying unchanged content uses the same request ID.</span></div>}
    </div><div className="modal-footer"><button type="button" className="button secondary" disabled={sending} onClick={onClose}>Close</button><button type="submit" className="button" disabled={sending || !detail?.contextHash || !reviewed || !acknowledged || !request.trim()} data-testid="handoff-submit">{sending ? <LoaderCircle size={16} className="spin" /> : <ArrowRight size={16} />}{sending ? 'Starting continuation…' : 'Continue in Relay'}</button></div>
  </form></Modal>;
}

export function CodexWorkspace({ sample, active, query, snapshot, navigate, Modal, onContinued, onBusyChange, onSelectTask }) {
  const { data, busy, error, load, olderHistoryLoaded } = useCatalog(sample, active);
  const [projectKey, setProjectKey] = useState('');
  const [activity, setActivity] = useState('all');
  const [selected, setSelected] = useState(null);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(40);
  useEffect(() => { if (sample) { setSelected(null); setMemoryOpen(false); setProjectKey(''); setActivity('all'); } }, [sample]);
  useEffect(() => setVisibleCount(40), [query, projectKey, activity]);
  const threads = data?.threads || [];
  const filtered = useMemo(() => filterCatalogThreads(threads, { query, projectKey, activity }), [threads, query, projectKey, activity]);
  const groups = useMemo(() => groupCatalogThreads(filtered.slice(0, visibleCount)), [filtered, visibleCount]);
  const activeThreads = threads.filter(thread => catalogActivity(thread).state === 'active');
  const unknownCount = threads.filter(thread => catalogActivity(thread).state === 'unknown').length;
  const projects = data?.projects || [];
  const activeTasks = snapshot.tasks.filter(task => ['running', 'waiting', 'cancel_requested'].includes(task.status));
  return <div className="page catalog-page" hidden={!active}>
    <div className="page-heading catalog-heading"><div><span className="eyebrow">Your Codex workspace</span><h1>Every project.<br className="catalog-mobile-break" /><em> One place to return.</em></h1><p>Find your chats, see the work Relay can verify, and pick up in one conversation.</p></div><button className="button" onClick={() => navigate('conversation')}><MessageSquare size={16} />Open master conversation</button></div>
    <div className="catalog-work-strip"><div><Activity size={18} /><span><strong>{sample ? 'Sample workspace' : `${activeTasks.length} active ${activeTasks.length === 1 ? 'run' : 'runs'} in Relay`}</strong><small>{sample ? 'Live Codex discovery is paused.' : 'Based on Relay’s current execution records.'}</small></span></div><div className="catalog-work-links"><button className="text-button" onClick={() => navigate('needs_you')}>Needs you <ArrowRight size={14} /></button><button className="text-button" onClick={() => navigate('goals')}><Target size={14} />Project goals</button></div></div>
    {!sample && activeTasks.length > 0 && <section className="catalog-active-runs" aria-label="Confirmed Relay activity">{activeTasks.slice(0, 4).map(task => <button key={task.id} onClick={() => onSelectTask(task.id)}><span className="live-dot active" /><span><strong>{task.title || 'Relay run'}</strong><small>{snapshot.projects.find(project => project.id === task.projectId)?.name || 'Master conversation'} · {task.status.replaceAll('_', ' ')}</small></span><ChevronRight size={15} /></button>)}</section>}
    {sample ? <section className="panel catalog-empty"><BookOpen size={28} /><h2>Live discovery stays private.</h2><p>This sample view does not read your Codex chats or memory. Return to live to discover your projects, or explore the sample goals and conversation.</p><button className="button secondary" onClick={() => navigate('overview')}>Explore sample goals <ArrowRight size={15} /></button></section> : <>
      <div className="catalog-toolbar"><div><h2>Projects & chats <span className="count-pill">{threads.length}</span></h2><p>{data?.scannedAt ? `Last checked ${formatCatalogDate(data.scannedAt)}` : 'Read from your local Codex history. No automatic agent prompts.'}</p></div><div className="catalog-toolbar-actions"><button className="button secondary" onClick={() => setMemoryOpen(true)}><BookOpen size={15} />Memory context</button><button className="button secondary" onClick={() => load(true)} disabled={busy} data-testid="refresh-catalog"><RefreshCw size={15} className={busy ? 'spin' : ''} />{busy ? 'Checking…' : 'Refresh'}</button></div></div>
      {error && <div className="error-banner" role="alert"><CircleAlert size={17} /><span>{error}{data && ' The last loaded history remains below; it may be out of date.'}</span><button className="text-button" onClick={() => load(true)} disabled={busy}>Retry</button></div>}
      <Notices warnings={data?.warnings} />
      {olderHistoryLoaded && <p className="catalog-source catalog-refresh-paused"><Clock3 size={14} />Automatic refresh is paused while you browse older chats. Refresh returns to the latest history.</p>}
      {data?.partial && <p className="catalog-notice"><CircleAlert size={15} />This is a partial view of your Codex history.{data.nextCursor ? ' Load more chats below to discover older projects.' : ' Some records may not be available; inspect the notices above.'}</p>}
      {!data && busy ? <section className="panel catalog-empty" role="status"><LoaderCircle size={25} className="spin" /><h2>Finding your projects…</h2><p>Reading chat directories and recent activity from Codex. Your original chats remain unchanged.</p></section> : data && !data.available ? <section className="panel catalog-empty"><CircleAlert size={27} /><h2>Codex discovery is unavailable.</h2><p>Connect the installed Codex provider, then refresh. Existing Relay goals and your master conversation are still available.</p><button className="button secondary" onClick={() => navigate('connections')}>Open connections <ArrowRight size={15} /></button></section> : data && <>
        <div className="catalog-filter-bar"><label><span>Project</span><select className="text-input" value={projectKey} onChange={event => setProjectKey(event.target.value)} data-testid="catalog-project-filter"><option value="">All projects ({projects.length})</option>{projects.map(project => <option key={project.key} value={project.key}>{project.name} · {project.threadCount} chats</option>)}</select></label><label><span>Activity</span><select className="text-input" value={activity} onChange={event => setActivity(event.target.value)} data-testid="catalog-activity-filter"><option value="all">All chats</option><option value="active">Active in Relay ({activeThreads.length})</option><option value="unknown">Live status unknown ({unknownCount})</option><option value="idle">No active Relay run</option></select></label><p>{filtered.length} {filtered.length === 1 ? 'chat' : 'chats'}{query && ` matching “${query}”`}<span>Grouped by recorded working directory</span></p></div>
        <div className="catalog-projects">{groups.map(group => <section className="panel catalog-project" key={group.key}><header><span className="catalog-folder"><FolderKanban size={21} /></span><div><h2>{group.name}</h2><p>{group.workspace || 'No working directory recorded'}</p></div><span className="count-pill">{filtered.filter(thread => (thread.projectKey || 'unassigned') === group.key).length} chats</span></header><div className="catalog-thread-list">{group.threads.map(thread => <button className="catalog-thread" key={thread.id} onClick={() => setSelected(thread)} data-testid="catalog-thread"><span className="catalog-thread-icon">{thread.parentThreadId ? <GitBranch size={17} /> : <MessageSquare size={17} />}</span><span className="catalog-thread-copy"><strong>{thread.title || 'Untitled Codex chat'}</strong><span>{thread.preview || 'Open to inspect the recorded context.'}</span><small>{thread.ownership === 'relay' ? 'Relay session' : 'Existing Codex chat'}{thread.parentThreadId ? ' · Background agent' : ''}{thread.archived ? ' · Archived' : ''}</small></span><span className="catalog-thread-meta"><CatalogStatus thread={thread} /><time>{formatCatalogDate(thread.updatedAt)}</time></span><ChevronRight size={15} className="catalog-thread-arrow" /></button>)}</div></section>)}</div>
        {!groups.length && <section className="panel catalog-empty"><Search size={28} /><h2>{threads.length ? 'No chats match this view.' : 'No Codex chats found yet.'}</h2><p>{threads.length ? 'Try a different search, project, or activity filter. Older chats may be outside the loaded history.' : 'Start a chat in Codex and refresh, or begin new work in the master conversation. Chats will be organized by their recorded project directory.'}</p>{(projectKey || activity !== 'all') && <button className="button secondary" onClick={() => { setProjectKey(''); setActivity('all'); }}>Clear filters</button>}</section>}
        {(filtered.length > visibleCount || data.nextCursor) && <div className="catalog-load-more"><button className="button secondary" disabled={busy} onClick={() => filtered.length > visibleCount ? setVisibleCount(count => count + 40) : load(true, true)}>{busy ? 'Loading…' : filtered.length > visibleCount ? 'Show more matching chats' : 'Load older chats'}</button><span>Only the loaded history is searched.</span></div>}
        <div className="catalog-privacy"><ShieldCheck size={16} /><p>Discovery reads local history. External chats have <strong>unknown live status</strong>; a recorded reply is not proof of completed work. Browsing alone sends no context to an agent. Continue requires your review; requests in the master conversation can retrieve relevant history.</p></div>
      </>}
    </>}
    {!sample && selected && <ThreadDetails key={selected.id} selected={selected} Modal={Modal} onClose={() => setSelected(null)} onBusyChange={onBusyChange} onContinued={result => { setSelected(null); onContinued(result); }} />}
    {!sample && memoryOpen && <MemoryDetails Modal={Modal} onClose={() => setMemoryOpen(false)} />}
  </div>;
}
