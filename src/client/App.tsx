import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ArrowDownToLine, ArrowRight, Check, ChevronRight, CircleHelp, Clapperboard, Clock3, Code2, Crop, FileVideo, FolderOpen, Layers3, LoaderCircle, MonitorPlay, Play, Plus, Scissors, Settings2, ShieldCheck, Sparkles, Subtitles, Tv as Twitch, Upload, X } from 'lucide-react';
import type { ClipEdit, Health, Job, RenderOptions, Vod } from '../shared/types.js';
import { MAX_HIGHLIGHT_COUNT, parseVodId, validateEdits } from '../shared/validation.js';
import { api, uploadRecording } from './api.js';
import PublicTwitchModes from './PublicTwitchModes.js';
import LivestreamAnalyzer from './LivestreamAnalyzer.js';
import SourceRightsEditor from './SourceRightsEditor.js';
import RetentionEditor from './RetentionEditor.js';
import { retentionSettingsSchema } from '../shared/retention.js';
import type { RetentionSettings } from '../shared/retention.js';
import { normalizeRights, unknownRights, sourceRightsSchema } from '../shared/rights.js';
import type { SourceRights } from '../shared/rights.js';

const time = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
type Mode = 'upload' | 'twitch' | 'remote';
type TwitchClip = { id: string; edit_url: string; broadcasterId: string };

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [job, setJob] = useState<Job | null>(null); const [jobs, setJobs] = useState<Job[]>([]);
  const [view, setView] = useState<'workbench' | 'library' | 'setup'>('workbench');
  const [workflowMode, setWorkflowMode] = useState<'analyzer' | 'discover' | 'live' | 'authorized'>(() => new URLSearchParams(window.location.search).get('twitch') === 'connected' ? 'live' : 'analyzer');
  const [mode, setMode] = useState<Mode>('upload'); const [url, setUrl] = useState('https://www.twitch.tv/videos/2895693134');
  const [vod, setVod] = useState<Vod | null>(null); const [embedId, setEmbedId] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null); const [remote, setRemote] = useState('');
  const [permission, setPermission] = useState(false); const [offset, setOffset] = useState(0);
  const [rights, setRights] = useState<SourceRights>(unknownRights);
  const durationMode = 'auto';
  const [highlightLimit, setHighlightLimit] = useState<number | null>(null);
  const clipCount = Math.max(1, Math.min(MAX_HIGHLIGHT_COUNT, highlightLimit ?? (typeof health?.editorDefaults?.clipCount === 'number' ? health.editorDefaults.clipCount : MAX_HIGHLIGHT_COUNT)));
  const [qualityScore, setQualityScore] = useState<number | null>(null);
  const minEngagementScore = qualityScore ?? health?.editorDefaults?.minEngagementScore ?? 70;
  const [busy, setBusy] = useState(''); const [uploadPercent, setUploadPercent] = useState(0); const [error, setError] = useState('');
  const [selected, setSelected] = useState<string[]>([]); const [edits, setEdits] = useState<Record<string, ClipEdit>>({});
  const editsJob = useRef<string | null>(null);
  const [options, setOptions] = useState<RenderOptions>({ layout: 'blur', cropX: 0.5, subtitles: false });
  const [retention, setRetention] = useState<RetentionSettings>(() => retentionSettingsSchema.parse({}));
  const [preview, setPreview] = useState<ClipEdit | null>(null);
  const [manualStart, setManualStart] = useState(0); const [manualEnd, setManualEnd] = useState(45); const [manualTitle, setManualTitle] = useState('Stream highlight');
  const [clip, setClip] = useState<TwitchClip | null>(null); const [clipLinks, setClipLinks] = useState<{ landscape_download_url: string | null; portrait_download_url: string | null }[]>([]);
  const [clipMessage, setClipMessage] = useState(''); const [drag, setDrag] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null); const video = useRef<HTMLVideoElement>(null);
  const processing = !!job && ['queued', 'analyzing', 'rendering'].includes(job.status);
  const enginesReady = !!health && health.ffmpeg && health.ffprobe && health.whisper && health.ollama;
  const highlightsKey = job ? `${job.id}:${job.highlights.map(h => `${h.id}/${h.start}/${h.end}`).join(',')}` : '';
  const loadHealth = useCallback(async () => { try { setHealth(await api<Health>('/health')); } catch (e) { setError(String(e)); } }, []);
  const loadJobs = useCallback(async () => { try { setJobs(await api<Job[]>('/jobs')); } catch { /* initial diagnostics surface server errors */ } }, []);
  useEffect(() => { void loadHealth(); void loadJobs(); }, [loadHealth, loadJobs]);
  useEffect(() => { setRights(normalizeRights(job?.rights)); if (job) { setQualityScore(job.minEngagementScore ?? 70); setHighlightLimit(typeof job.clipCount === 'number' ? job.clipCount : MAX_HIGHLIGHT_COUNT); } }, [job?.id]);
  useEffect(() => { if (job?.retentionSettings) setRetention(retentionSettingsSchema.parse(job.retentionSettings)); }, [job?.id]);
  useEffect(() => {
    if (!job || !processing) return;
    let active = true;
    const poll = async () => { try { const updated = await api<Job>(`/jobs/${job.id}`); if (active) setJob(updated); } catch (e) { if (active) setError(String(e)); } };
    const timer = setInterval(() => void poll(), 1500);
    return () => { active = false; clearInterval(timer); };
  }, [job?.id, processing]);
  useEffect(() => {
    if (!job?.highlights.length || processing) return;
    const sameProject = editsJob.current === job.id; editsJob.current = job.id;
    setEdits(current => Object.fromEntries(job.highlights.map(h => [h.id, { id: h.id, start: h.start, end: h.end, ...job.clipEdits?.find(e => e.id === h.id), ...(sameProject ? current[h.id] : {}) }])));
    setSelected(job.highlights.map(h => h.id)); void loadJobs();
  }, [highlightsKey, job?.status, loadJobs]);
  const attempt = async (label: string, work: () => Promise<void>) => {
    setError(''); setBusy(label); try { await work(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(''); }
  };
  const inspectVod = () => void attempt('Looking up VOD', async () => {
    const id = parseVodId(url); setEmbedId(id); setVod(null); setClip(null); setClipLinks([]);
    const data = await api<{ vod: Vod }>(`/twitch/video?input=${encodeURIComponent(url)}`); setVod(data.vod);
  });
  const ingest = () => void attempt('Uploading recording', async () => {
    if (!permission) throw new Error('Confirm permission to process this recording.');
    const record = sourceRightsSchema.parse(rights);
    if (mode === 'remote') {
      setJob(await api<Job>('/jobs/import', { url: remote, permission, vodId: vod?.id || '', vodOffset: offset, rights: record, durationMode, clipCount, minEngagementScore }));
    } else {
      if (!file) throw new Error('Choose an MP4 recording first.');
      const form = new FormData(); form.append('permission', 'true'); form.append('vodId', vod?.id || ''); form.append('vodOffset', String(offset)); form.append('media', file);
      form.append('rights', JSON.stringify(record)); form.append('durationMode', durationMode); form.append('clipCount', String(clipCount));
      form.append('minEngagementScore', String(minEngagementScore));
      setUploadPercent(0); setJob(await uploadRecording(form, setUploadPercent));
    }
    setPreview(null); setSelected([]); setView('workbench'); await loadJobs();
  });
  const saveRights = () => void attempt('Saving rights record', async () => {
    if (!job) return;
    const saved = await api<{ rights: SourceRights }>(`/jobs/${job.id}/rights`, sourceRightsSchema.parse(rights), 'PUT');
    setRights(saved.rights); setJob({ ...job, rights: saved.rights }); await loadJobs();
  });
  const analyze = () => void attempt('Starting analysis', async () => { if (job) { const updated = await api<Job>(`/jobs/${job.id}/analyze`, { durationMode, clipCount, minEngagementScore, retention }); setEdits(updated.status === 'review' ? Object.fromEntries(updated.highlights.map(h => [h.id, { id: h.id, start: h.start, end: h.end }])) : {}); setJob(updated); } });
  const regenerate = () => void attempt('Regenerating retention edits', async () => { if (job) setJob(await api<Job>(`/jobs/${job.id}/retention`, { settings: retention, clips: job.highlights.map(h => edits[h.id] || { id: h.id, start: h.start, end: h.end }) })); });
  const render = () => void attempt('Starting export', async () => {
    if (!job) return; const clips = selected.map(id => edits[id]!); validateEdits(clips, job.media.duration);
    setJob(await api<Job>(`/jobs/${job.id}/render`, { clips, options: { ...options, retention } }));
  });
  const playHighlight = (edit: ClipEdit) => {
    setPreview(edit); if (video.current) { video.current.currentTime = edit.start; void video.current.play().catch(() => {}); }
  };
  const newProject = () => { setJob(null); setFile(null); setVod(null); setEmbedId(null); setClip(null); setError(''); setPreview(null); setPermission(false); setRights(unknownRights()); setQualityScore(null); setHighlightLimit(null); setRetention(retentionSettingsSchema.parse({})); setView('workbench'); };
  const selectJob = (recording: Job) => { setJob(recording); setRetention(retentionSettingsSchema.parse(recording.retentionSettings || {})); setPreview(null); setView('workbench'); setWorkflowMode('authorized'); setError(''); };
  const createClip = () => void attempt('Creating authorized Twitch clip', async () => {
    if (!permission || !vod) throw new Error('Confirm broadcaster/editor authorization and look up the VOD first.');
    const result = await api<TwitchClip>('/twitch/clips', { vodId: vod.id, start: manualStart, end: manualEnd, title: manualTitle, permission: true });
    setClip(result); setClipLinks([]); setClipMessage('Twitch is preparing the clip. Checking official download availability…');
  });
  useEffect(() => {
    if (!clip) return; let stopped = false; let attempts = 0;
    const poll = async () => {
      try {
        const result = await api<{ downloads: typeof clipLinks }>(`/twitch/clips/downloads?broadcasterId=${clip.broadcasterId}&clipId=${encodeURIComponent(clip.id)}`);
        if (stopped) return;
        const ready = result.downloads.some(d => d.landscape_download_url || d.portrait_download_url);
        if (ready) { setClipLinks(result.downloads); setClipMessage('Authorized download links are ready; links expire.'); clearInterval(timer); }
        else if (++attempts >= 20) { setClipMessage('Download is not available yet. Open the official editor or retry the download lookup.'); clearInterval(timer); }
      } catch (e) { if (!stopped) setClipMessage(e instanceof Error ? e.message : String(e)); clearInterval(timer); }
    };
    const timer = setInterval(() => void poll(), 3000); void poll();
    return () => { stopped = true; clearInterval(timer); };
  }, [clip]);

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#" onClick={e => { e.preventDefault(); setView('workbench'); }}><span className="brand-icon"><Scissors size={21} /></span>CUTLINE<span className="brand-dot">●</span></a>
      <div className="workspace-label">YOUR WORKSPACE</div>
      <nav>
        <button className={view === 'workbench' ? 'nav-item active' : 'nav-item'} onClick={() => setView('workbench')}><Layers3 size={18} />Workbench<span className="nav-tag">AI</span></button>
        <button className={view === 'library' ? 'nav-item active' : 'nav-item'} onClick={() => { setView('library'); void loadJobs(); }}><FolderOpen size={18} />Recordings<span className="nav-count">{jobs.length}</span></button>
        <button className={view === 'setup' ? 'nav-item active' : 'nav-item'} onClick={() => { setView('setup'); void loadHealth(); }}><Settings2 size={18} />Local setup</button>
      </nav>
      <div className="sidebar-note"><ShieldCheck size={20} /><strong>Your footage. Your machine.</strong><p>Local transcription and AI ranking. Your recordings stay with you.</p><span><span className="green-dot" /> LOCAL WORKSPACE</span></div>
      <div className="sidebar-bottom"><div className="avatar">LC</div><div><strong>Local creator</strong><small>Personal workspace</small></div><CircleHelp size={17} onClick={() => setView('setup')} role="button" tabIndex={0} aria-label="Open setup help" onKeyDown={e => { if (e.key === 'Enter') setView('setup'); }} /></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb">Workspace<ChevronRight size={14} /><span>{view === 'workbench' ? workflowMode === 'analyzer' ? 'AI Livestream Highlight Analyzer' : 'AI Stream Clipper' : view === 'library' ? 'Recordings' : 'Local setup'}</span></div><div className="topbar-actions"><span className="local-badge"><span className="green-dot" />RUNS LOCALLY</span><button className="button small secondary" onClick={newProject}><Plus size={15} />New project</button></div></header>
      <main>
        <div className="page-heading"><div><div className="eyebrow"><Sparkles size={13} /> MADE FOR THE MOMENTS THAT MATTER</div><h1>{view === 'workbench' ? <>Long streams. <span>Short-form gold.</span></> : view === 'library' ? 'Your recordings' : 'Set up your studio'}</h1><p>{view === 'workbench' ? workflowMode === 'analyzer' ? 'Find evidence-supported highlight timestamps. Review the original stream and clip manually.' : 'Find the highlights, make them yours, and turn your stream into shareable clips.' : view === 'library' ? 'Pick up where you left off. Analysis and exports are saved locally.' : 'Connect your local tools once. Create clips on your own machine.'}</p></div><span className="version">MVP / 01</span></div>
        {error && <div className="alert error" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={17} /></button></div>}
        {view === 'setup' ? <section className="panel setup"><div className="panel-title"><Settings2 size={19} /><h2>Engine room</h2><button className="button small secondary" onClick={() => void loadHealth()}>Refresh status</button></div><p>Install FFmpeg and ffprobe, local Whisper, and Ollama. See README.md for Windows PowerShell installation and OAuth setup.</p><div className="engine-grid">{(['ffmpeg', 'ffprobe', 'whisper', 'ollama'] as const).map(engine => <div className="engine" key={engine}><Activity size={19} /><strong>{engine}</strong><span className={health?.[engine] ? 'ready' : 'unavailable'}>{health?.[engine] ? 'Ready' : 'Needs setup'}</span></div>)}</div><div className="code-block">pip install -U openai-whisper<br />ollama pull llama3.2:3b<br />ollama serve</div><p>Whisper: <code>{health?.whisperModel || 'base'}</code> · Ollama: <code>{health?.model || 'llama3.2:3b'}</code>. Twitch credentials belong in server <code>.env</code>; the browser never receives tokens. Health checks verify executables and the installed Ollama model; Whisper downloads its model on first use.</p><div className="notice"><ShieldCheck size={18} /><span>Remote imports are disabled until an operator configures exact HTTPS hostnames in APPROVED_MEDIA_HOSTS. Only import media you have permission to process.</span></div></section>
        : view === 'library' ? <section className="panel library"><div className="panel-title"><FolderOpen size={19} /><h2>Saved recordings</h2><span>{jobs.length} projects</span></div>{jobs.length ? jobs.map(recording => <button key={recording.id} className="recording-row" onClick={() => selectJob(recording)}><span className="file-icon"><FileVideo size={23} /></span><span><strong>{recording.name}</strong><small>{time(recording.media.duration)} · {new Date(recording.createdAt).toLocaleDateString()} · {recording.highlights.length} highlights</small></span><span className="status-pill">{recording.status}</span><ChevronRight size={17} /></button>) : <div className="empty-library"><FolderOpen size={38} /><h3>A fresh start</h3><p>Your uploaded recordings will appear here.</p><button className="button primary" onClick={newProject}>Create your first project<ArrowRight size={15} /></button></div>}</section>
        : <>
          <div className="mode-selector" aria-label="Clip workflow mode">{([{ id: 'analyzer', title: 'Analyze livestream highlights', detail: 'Twitch & YouTube · Timestamps', icon: Clock3 }, { id: 'discover', title: 'Discover existing VOD clips', detail: 'Public clips · Views & titles', icon: Clapperboard }, { id: 'live', title: 'Create live Twitch clips', detail: 'Viewer account · Live moments', icon: Twitch }, { id: 'authorized', title: 'Analyze authorized recording', detail: 'Local AI · Vertical exports', icon: FileVideo }] as const).map(item => <button key={item.id} aria-pressed={workflowMode === item.id} aria-label={item.title} className={`mode-option ${workflowMode === item.id ? 'active' : ''}`} onClick={() => setWorkflowMode(item.id)}><item.icon size={19} /><span><strong>{item.title}</strong><small>{item.detail}</small></span>{workflowMode === item.id && <Check size={16} />}</button>)}</div>
          <div hidden={workflowMode !== 'analyzer'}><LivestreamAnalyzer onRecording={() => setWorkflowMode('authorized')} /></div>
          <div hidden={workflowMode !== 'discover' && workflowMode !== 'live'}><PublicTwitchModes mode={workflowMode === 'live' ? 'live' : 'discover'} onRecording={() => setWorkflowMode('authorized')} /></div>
          <div hidden={workflowMode !== 'authorized'}>
          <RetentionEditor job={job} settings={retention} onSettings={setRetention} edits={edits} onEdit={edit => setEdits(current => ({ ...current, [edit.id]: edit }))} selected={selected} onJob={setJob} onRegenerate={regenerate} onExport={render} disabled={processing || !!busy} />
          <div className="workflow">{[{ text: 'Add your stream', done: !!job, active: !job }, { text: 'Find the highlights', done: !!job?.highlights.length, active: !!job && !job.highlights.length }, { text: 'Review & export', done: job?.status === 'complete', active: !!job?.highlights.length }].map((step, i) => <div className={`workflow-step ${step.active ? 'current' : ''} ${step.done ? 'done' : ''}`} key={step.text}><span>{step.done ? <Check size={13} /> : `0${i + 1}`}</span>{step.text}{i < 2 && <div className="step-line" />}</div>)}</div>
          <div className="workbench-grid">
            <div className="left-column">
              <section className="panel source-panel"><div className="panel-title"><span className="step-icon"><FileVideo size={18} /></span><h2>Source recording</h2><span className="panel-meta">01 / INPUT</span></div>
                <div className="tabs">{[{ id: 'upload', label: 'Upload video', icon: Upload }, { id: 'twitch', label: 'Twitch VOD', icon: Twitch }, { id: 'remote', label: 'Approved URL', icon: Code2 }].map(tab => <button disabled={processing || !!busy} key={tab.id} className={mode === tab.id ? 'tab active' : 'tab'} onClick={() => setMode(tab.id as Mode)}><tab.icon size={15} />{tab.label}</button>)}</div>
                {mode === 'twitch' ? <div className="input-area"><label htmlFor="vod-url">Twitch VOD URL or ID</label><div className="joined-input"><Twitch size={18} /><input id="vod-url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://www.twitch.tv/videos/…" /><button onClick={inspectVod} disabled={!!busy}>Look up<ArrowRight size={15} /></button></div><small>Metadata and playback only. A public URL does not grant media access.</small>{vod && <div className="vod-details"><strong>{vod.title}</strong><small>{vod.user_name} · {vod.duration} · {vod.view_count.toLocaleString()} views</small></div>}<div className="notice"><ShieldCheck size={17} /><span>Automatic analysis needs an authorized full recording. Upload your own MP4, or use the official clip API as the broadcaster or a channel editor.</span></div><button className="text-button" onClick={() => setMode('upload')}>Add an authorized recording<ArrowRight size={14} /></button></div>
                : mode === 'remote' ? <div className="input-area"><label htmlFor="remote-url">Approved media source</label><input id="remote-url" value={remote} onChange={e => setRemote(e.target.value)} placeholder="https://your-approved-host/recording.mp4" /><small>Requires operator host allowlisting. Redirects and private network addresses are blocked.</small></div>
                : <div className={`dropzone ${drag ? 'dragging' : ''}`} onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={e => { e.preventDefault(); setDrag(false); if (!processing && !busy) setFile(e.dataTransfer.files[0] || null); }}><div className="upload-icon"><Upload size={23} /></div><h3>{file ? file.name : 'Drop your recording here'}</h3><p>{file ? `${(file.size / 1024 ** 2).toFixed(1)} MB · Ready to upload` : 'Your stream recording, ready for its next chapter.'}</p><button className="button secondary small" onClick={() => fileInput.current?.click()} disabled={processing || !!busy}><FolderOpen size={14} />{file ? 'Choose another file' : 'Browse files'}</button><small>MP4 · Up to 20 GB by default</small><input ref={fileInput} aria-label="Choose MP4 recording" type="file" accept="video/mp4,.mp4" hidden onChange={e => setFile(e.target.files?.[0] || null)} /></div>}
                <div className="source-footer"><label className="checkbox"><input type="checkbox" checked={permission} onChange={e => setPermission(e.target.checked)} /><span>{mode === 'twitch' ? 'I am the broadcaster or an authorized channel editor.' : 'I may process this recording privately. This does not establish publishing rights.'}</span></label>{mode !== 'twitch' && <><label className="offset-label" htmlFor="offset">Recording starts at VOD second <input id="offset" type="number" min="0" value={offset} onChange={e => setOffset(Number(e.target.value))} /></label><button className="button secondary full" disabled={!permission || (mode === 'upload' ? !file : !remote) || processing || !!busy} onClick={ingest}>{busy === 'Uploading recording' ? <LoaderCircle size={16} className="spin" /> : <Upload size={16} />}{busy === 'Uploading recording' ? `Uploading ${uploadPercent}% · validating media` : 'Upload recording'}</button></>}</div>
              </section>
              <section className="panel analysis-panel"><div className="panel-title"><span className="step-icon violet"><Sparkles size={18} /></span><h2>Highlight recipe</h2><span className="panel-meta">02 / ANALYZE</span></div><div className="recipe-grid"><div><span>CLIPS</span><strong>Up to {clipCount}<small>best moments</small></strong></div><div><span>DURATION</span><strong>AI chosen<small>natural boundaries</small></strong></div><div><span>FORMAT</span><strong>9:16 <small>vertical</small></strong></div></div>
                <label className="policy-control">Duration mode<select aria-label="Duration mode" value={durationMode} disabled><option value="auto">Auto · AI determines each clip duration</option></select></label>
                <label className="policy-control">Maximum highlights<select aria-label="Maximum highlights" value={clipCount} disabled={processing || !!busy} onChange={e => setHighlightLimit(Number(e.target.value))}>{[1, 2, 3, 4, 5, 6, 7, 8].map(count => <option key={count} value={count}>{count} best moments</option>)}</select></label>
                <label className="policy-control">Minimum engagement score<input aria-label="Minimum engagement score" type="number" min="0" max="100" step="1" value={minEngagementScore} disabled={processing || !!busy} onChange={e => setQualityScore(Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0))))} /></label>
                <small className="engine-hint">Shortlist promising moments for faster analysis, then keep up to {clipCount} that meet this score. Fewer are returned when evidence is weak. Preview the results.</small>
                <div className="content-tag"><Activity size={14} />Hook · story · emotional impact<span>Standalone coherence</span></div><button className="button primary full analyze-button" onClick={analyze} disabled={!job || !enginesReady || processing || !!busy}><Sparkles size={18} />{processing && job.status !== 'rendering' ? 'Finding your highlights…' : job?.highlights.length ? 'Analyze again' : 'Analyze stream'}<ArrowRight size={17} /></button><div className="engine-status"><span className={health?.whisper ? 'green-dot' : 'amber-dot'} />Whisper<span className={health?.ollama ? 'green-dot' : 'amber-dot'} />Ollama<span className={health?.ffmpeg && health.ffprobe ? 'green-dot' : 'amber-dot'} />FFmpeg<button onClick={() => { setView('setup'); void loadHealth(); }}>Manage<ChevronRight size={12} /></button></div>{!enginesReady && <small className="engine-hint">{health ? 'Install missing local engines to enable analysis.' : 'Checking local engines…'}</small>}</section>
              <SourceRightsEditor rights={rights} onChange={setRights} disabled={processing || !!busy} dirty={JSON.stringify(rights) !== JSON.stringify(normalizeRights(job?.rights))} {...(job ? { onSave: saveRights } : {})} />
            </div>
            <div className="right-column">
              <section className="panel preview-panel"><div className="panel-title"><MonitorPlay size={18} /><h2>{job ? 'Recording preview' : 'Stream preview'}</h2><span className="panel-meta">{job ? `${job.media.width} × ${job.media.height}` : 'YOUR CREATIVE CANVAS'}</span></div><div className="preview-canvas">{job ? <video key={job.id} ref={video} src={`/api/jobs/${job.id}/media`} controls preload="metadata" onTimeUpdate={() => { if (preview && video.current && video.current.currentTime >= preview.end) video.current.pause(); }} /> : embedId ? <iframe title="Twitch VOD preview" src={`https://player.twitch.tv/?video=v${embedId}&parent=${encodeURIComponent(window.location.hostname)}&autoplay=false`} allowFullScreen /> : <div className="empty-preview"><div className="canvas-grid" /><div className="play-outline"><Play size={25} /></div><span className="preview-kicker">FROM THE FULL STREAM TO THE GOOD STUFF</span><h3>Your next highlight<br />starts here.</h3><p>Add a recording to bring your timeline to life.</p><div className="canvas-tags"><span><Clock3 size={12} />AI-chosen ranges</span><span><Crop size={12} />1080 × 1920</span></div></div>}</div><div className="preview-footer"><div><span className={job ? 'green-dot' : 'neutral-dot'} /><span>{job ? job.name : embedId ? `Twitch VOD ${embedId} · metadata-only access` : 'No recording added yet'}</span></div><span>{job ? time(job.media.duration) : '— : —'}</span></div>{job?.highlights.length ? <div className="timeline"><span>HIGHLIGHT MAP</span><div className="timeline-track">{job.highlights.map((h, i) => <button aria-label={`Preview highlight ${i + 1}`} key={h.id} style={{ left: `${h.start / job.media.duration * 100}%`, width: `${(h.end - h.start) / job.media.duration * 100}%` }} onClick={() => playHighlight(edits[h.id] || h)}>{i + 1}</button>)}</div><div className="timeline-labels"><span>00:00</span><span>{time(job.media.duration)}</span></div></div> : null}</section>
              <section className="panel highlights-panel"><div className="panel-title"><Clapperboard size={19} /><h2>Your highlights</h2><span className="count-badge">{job?.highlights.length || 0}</span>{!!job?.highlights.length && <span className="panel-meta">{selected.length} SELECTED</span>}</div>
                {processing ? <div className="progress-area" role="status"><div className="progress-top"><LoaderCircle className="spin" size={20} /><strong>{job.stage}</strong><span>{job.progress}%</span></div><div className="progress-track"><div style={{ width: `${job.progress}%` }} /></div><p>{job.status === 'rendering' ? 'Rendering locally. Keep this server running; you can return to the project later.' : 'Reading the story behind the energy. Long recordings take time; completed chunks are cached.'}</p></div>
                : job?.error ? <div className="notice error"><Activity size={19} /><span>{job.error}</span></div>
                : !job?.highlights.length ? <div className="empty-highlights"><div className="stacked-cards"><div /><div /><div><Sparkles size={22} /></div></div><h3>{job?.status === "review" ? "No qualifying highlights found." : "The best moments are waiting."}</h3><p>AI will look for the reactions, the unexpected turns,<br />and the moments worth watching again.</p><div className="feature-pills"><span>Humor & surprise</span><span>Scene changes</span><span>Story & context</span></div></div> : null}
                {!!job?.highlights.length && !processing && <div className="highlight-list">{job.highlights.map((h, i) => {
                  const edit = edits[h.id] || h; const chosen = selected.includes(h.id);
                  return <article className={`highlight-card ${chosen ? 'selected' : ''}`} key={h.id}><div className="highlight-heading"><label className="checkbox"><input aria-label={`Select ${h.title}`} type="checkbox" checked={chosen} onChange={() => setSelected(chosen ? selected.filter(id => id !== h.id) : [...selected, h.id])} /><span className="clip-number">{String(i + 1).padStart(2, '0')}</span></label><h3>{h.title}</h3><span className="score">{h.score}<small>/100</small></span><button className="icon-button" aria-label={`Preview ${h.title}`} onClick={() => playHighlight(edit)}><Play size={15} /></button></div><p className="highlight-timing">{time(h.start)} → {time(h.end)} · AI score {h.score}/100 · heuristic {h.heuristicScore}/100</p><p>{h.explanation}</p><blockquote className="transcript-excerpt">{h.transcript ? `${h.transcript.slice(0, 240)}${h.transcript.length > 240 ? "…" : ""}` : "No source speech in this interval."}</blockquote><div className="edit-row"><label>Start <input aria-label={`Start for ${h.title}`} type="number" min="0" step="0.1" value={edit.start} onChange={e => setEdits({ ...edits, [h.id]: { ...edit, start: Number(e.target.value) } })} /></label><ArrowRight size={12} /><label>End <input aria-label={`End for ${h.title}`} type="number" min="0" max={job.media.duration} step="0.1" value={edit.end} onChange={e => setEdits({ ...edits, [h.id]: { ...edit, end: Number(e.target.value) } })} /></label><span>{(edit.end - edit.start).toFixed(1)}s</span><small>Heuristic {h.heuristicScore}/100</small></div><details><summary>Evidence & transcript</summary><p>{h.evidence.join(' · ')}</p><p>{h.transcript || 'No speech in this window.'}</p></details></article>;
                })}</div>}
                {!!job?.warnings.length && <details className="analysis-notes"><summary>Analysis notes</summary>{job.warnings.map(w => <p key={w}>{w}</p>)}</details>}
              </section>
            </div>
          </div>
          {mode === 'twitch' && vod && <section className="panel twitch-panel"><div className="panel-title"><Twitch size={19} /><h2>Authorized Twitch clip</h2><span className="panel-meta">BROADCASTER / EDITOR ONLY</span></div><p>Create a known moment through Twitch’s official API. This does not enable full-VOD automatic analysis.</p><div className="manual-grid"><label>Title<input value={manualTitle} onChange={e => setManualTitle(e.target.value)} /></label><label>Start (seconds)<input type="number" min="0" step="0.1" value={manualStart} onChange={e => setManualStart(Number(e.target.value))} /></label><label>End (integer seconds)<input type="number" min="30" step="1" value={manualEnd} onChange={e => setManualEnd(Number(e.target.value))} /></label><button className="button secondary" disabled={!permission || !!busy || !health?.clipAuth} onClick={createClip}>Create Twitch clip<ArrowRight size={15} /></button></div>{!health?.clipAuth && <small>Configure a server-side OAuth user token with channel:manage:clips or editor:manage:clips.</small>}{clip && <div className="official-links"><p role="status">{clipMessage}</p><a href={clip.edit_url} target="_blank" rel="noreferrer">Open official Twitch editor<ArrowRight size={14} /></a><button className="text-button" onClick={() => setClip({ ...clip })}>Refresh download lookup</button>{clipLinks.map((links, i) => <div key={i}>{links.landscape_download_url && <a href={links.landscape_download_url} rel="noreferrer" target="_blank">Download landscape clip</a>}{links.portrait_download_url && <a href={links.portrait_download_url} rel="noreferrer" target="_blank">Download portrait clip</a>}</div>)}</div>}</section>}
          <section className="panel export-panel">
            <div className="export-heading"><span className="step-icon"><ArrowDownToLine size={18} /></span><div><h2>Create video drafts.</h2><p>1080 × 1920 · H.264 + AAC · Rendering does not clear publishing rights.</p></div></div>
            <div className="export-settings">
              <label><Crop size={15} /><select aria-label="Vertical layout" value={options.layout} onChange={e => setOptions({ ...options, layout: e.target.value as RenderOptions['layout'] })}><option value="blur">Blurred padding</option><option value="crop">Fill with crop</option></select></label>
              {options.layout === 'crop' && <label className="crop-position">Crop position<input aria-label="Horizontal crop position" type="range" min="0" max="1" step="0.05" value={options.cropX} onChange={e => setOptions({ ...options, cropX: Number(e.target.value) })} /></label>}
              <label className="checkbox"><input type="checkbox" checked={retention.captions.enabled} onChange={e => setRetention({ ...retention, captions: { ...retention.captions, enabled: e.target.checked } })} /><Subtitles size={16} /><span>Subtitles</span></label>
            </div>
            <button className="button primary" onClick={render} disabled={!selected.length || processing || !!busy || !job?.highlights.length}><Scissors size={17} />Generate {selected.length ? selected.length : ''} clips<ArrowRight size={16} /></button>
          </section>
          {job?.status === 'complete' && <section className="panel downloads"><div className="panel-title"><Check size={19} /><h2>Your video drafts are ready</h2><a className="button primary small" href={`/api/jobs/${job.id}/zip`}><ArrowDownToLine size={15} />Download ZIP</a></div><div className="download-links">{job.outputs.map(o => <a href={`/api/jobs/${job.id}/files/${o.file}`} key={o.file}><FileVideo size={17} />{o.file}<ArrowDownToLine size={14} /></a>)}<a href={`/api/jobs/${job.id}/results`}><Code2 size={17} />results.json<ArrowDownToLine size={14} /></a></div></section>}
          <footer className="page-footer"><span><ShieldCheck size={13} />Private analysis and drafts. Review source rights before publishing.</span><span>Built for creators. Kept local.</span></footer>
          </div>
        </>}
      </main>
    </div>
  </div>;
}
