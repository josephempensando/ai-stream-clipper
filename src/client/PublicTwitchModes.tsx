import { useEffect, useState } from 'react';
import { ArrowRight, Clapperboard, ExternalLink, Eye, LoaderCircle, MonitorPlay, Play, Radio, ShieldCheck, Tv } from 'lucide-react';
import type { ClipDiscovery, LiveClip, LiveStatus, RankedPublicClip, ViewerStatus } from '../shared/types.js';
import { parseVodId } from '../shared/validation.js';
import { api, ApiError } from './api.js';

interface Props { mode: 'discover' | 'live'; onRecording: () => void }
export default function PublicTwitchModes({ mode, onRecording }: Props) {
  const [url, setUrl] = useState('https://www.twitch.tv/videos/2895693134');
  const [discovery, setDiscovery] = useState<ClipDiscovery | null>(null);
  const [embedId, setEmbedId] = useState(''); const [preview, setPreview] = useState<RankedPublicClip | null>(null);
  const [channel, setChannel] = useState('caseoh_'); const [live, setLive] = useState<LiveStatus | null>(null);
  const [viewer, setViewer] = useState<ViewerStatus | null>(null); const [clips, setClips] = useState<LiveClip[]>([]);
  const [title, setTitle] = useState('Live highlight'); const [duration, setDuration] = useState(45);
  const [busy, setBusy] = useState(''); const [error, setError] = useState(''); const [retryUntil, setRetryUntil] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const parent = encodeURIComponent(window.location.hostname);
  const pending = clips.filter(c => c.status === 'pending').map(c => c.id).join(',');
  const wait = Math.max(0, Math.ceil((retryUntil - clock) / 1000));
  const reportError = (e: unknown) => {
    setError(e instanceof Error ? e.message : String(e));
    if (e instanceof ApiError && e.retryAfter) { setRetryUntil(Date.now() + e.retryAfter * 1000); setClock(Date.now()); }
    if (e instanceof ApiError && e.status === 401) void api<ViewerStatus>('/twitch/oauth/status').then(setViewer).catch(() => {});
  };
  const attempt = async (label: string, work: () => Promise<void>) => {
    if (busy || wait) return; setBusy(label); setError('');
    try { await work(); } catch (e) { reportError(e); } finally { setBusy(''); }
  };
  useEffect(() => {
    let active = true;
    void api<ViewerStatus>('/twitch/oauth/status').then(status => {
      if (!active) return; setViewer(status);
      if (status.connected) void api<LiveClip[]>('/twitch/live/clips').then(saved => { if (active) setClips(saved); }).catch(e => { if (active) reportError(e); });
    }).catch(e => { if (active) reportError(e); });
    return () => { active = false; };
  }, []);
  useEffect(() => { if (!wait) return; const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, [retryUntil, wait > 0]);
  useEffect(() => {
    if (!pending || !viewer?.connected) return; let active = true; let fetching = false; let blockedUntil = 0;
    const poll = async () => {
      if (fetching || Date.now() < blockedUntil) return; fetching = true;
      try {
        const updates = await Promise.all(pending.split(',').map(id => api<LiveClip>(`/twitch/live/clips/${encodeURIComponent(id)}`)));
        if (active) setClips(current => current.map(c => updates.find(u => u.id === c.id) || c));
      } catch (e) {
        if (e instanceof ApiError && e.retryAfter) blockedUntil = Date.now() + e.retryAfter * 1000;
        if (active) reportError(e);
      } finally { fetching = false; }
    };
    const timer = setInterval(() => void poll(), 3000); void poll();
    return () => { active = false; clearInterval(timer); };
  }, [pending, viewer?.connected]);
  const discover = () => void attempt('Finding public clips', async () => {
    const id = parseVodId(url); setEmbedId(id); setDiscovery(null); setPreview(null);
    setDiscovery(await api<ClipDiscovery>(`/twitch/discover?input=${encodeURIComponent(url)}`));
  });
  const connect = () => void attempt('Opening Twitch', async () => {
    const data = await api<{ url: string }>('/twitch/oauth/connect', {});
    const destination = new URL(data.url);
    if (destination.origin !== 'https://id.twitch.tv' || destination.pathname !== '/oauth2/authorize') throw new Error('Unexpected Twitch authorization redirect.');
    window.location.assign(data.url);
  });
  const disconnect = () => void attempt('Disconnecting Twitch', async () => {
    await api('/twitch/oauth/disconnect', {}); setViewer(await api<ViewerStatus>('/twitch/oauth/status')); setClips([]);
  });
  const checkLive = () => void attempt('Checking the channel', async () => { setLive(null); setLive(await api<LiveStatus>(`/twitch/live?channel=${encodeURIComponent(channel)}`)); });
  const create = () => void attempt('Requesting live clip', async () => {
    const result = await api<LiveClip>('/twitch/live/clips', { channel, title, duration });
    setClips(current => [result, ...current.filter(c => c.id !== result.id)]);
  });

  return <div className="public-workbench">
    {error && <div className="alert error" role="alert"><span>{error}{wait > 0 && ` Retry in ${wait}s.`}</span></div>}
    {busy && <div className="public-progress" role="status"><LoaderCircle size={16} className="spin" />{busy}…</div>}
    {mode === 'discover' ? <div className="workbench-grid">
      <div className="left-column">
        <section className="panel source-panel"><div className="panel-title"><Tv size={19} /><h2>Discover public VOD clips</h2><span className="panel-meta">PUBLIC METADATA</span></div>
          <div className="input-area"><label htmlFor="public-vod-url">Public Twitch VOD URL or ID</label><input id="public-vod-url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://www.twitch.tv/videos/…" />
            <button className="button primary full" disabled={!!busy || wait > 0} onClick={discover}><Clapperboard size={17} />Discover clips<ArrowRight size={16} /></button>
            <small>Find up to five existing 30–60 second clips linked to this VOD.</small>
            {discovery && <div className="vod-details"><strong>{discovery.vod.title}</strong><small>{discovery.vod.user_name} · {discovery.vod.duration} · {discovery.vod.view_count.toLocaleString()} VOD views</small></div>}
            <div className="notice"><ShieldCheck size={18} /><span>Ranked using public views and titles. No video/audio AI analysis or clip downloading. Watch and share through Twitch.</span></div>
            <button className="text-button" onClick={onRecording}>Analyze a recording you have permission to use<ArrowRight size={14} /></button>
          </div>
        </section>
        {discovery && <section className="panel public-summary"><div className="panel-title"><Eye size={18} /><h2>Search details</h2></div><p>{discovery.message}</p><small>{discovery.scanned} records scanned · {discovery.pages} pages · {discovery.matched} linked clips · {discovery.eligible} within 30–60 seconds</small>{discovery.truncated && <div className="notice"><span>Twitch’s search limit was reached. These results may omit other clips for this VOD.</span></div>}</section>}
      </div>
      <div className="right-column">
        <section className="panel preview-panel"><div className="panel-title"><MonitorPlay size={18} /><h2>{preview ? preview.title : 'Twitch VOD preview'}</h2><span className="panel-meta">WATCH ON TWITCH</span></div><div className="preview-canvas">{preview ? <iframe key={preview.id} title="Public clip preview" src={`https://clips.twitch.tv/embed?clip=${encodeURIComponent(preview.id)}&parent=${parent}&autoplay=false`} allowFullScreen /> : embedId ? <iframe title="Twitch VOD preview" src={`https://player.twitch.tv/?video=v${embedId}&parent=${parent}&autoplay=false`} allowFullScreen /> : <div className="empty-preview"><div className="play-outline"><Play size={25} /></div><h3>Find the moments<br />viewers already clipped.</h3><p>Enter a VOD to discover existing public clips.</p></div>}</div>{preview && <div className="preview-footer"><button className="text-button" onClick={() => setPreview(null)}>Back to VOD</button><a href={preview.url} target="_blank" rel="noreferrer">Open on Twitch<ExternalLink size={14} /></a></div>}</section>
        <section className="panel highlights-panel"><div className="panel-title"><Clapperboard size={19} /><h2>Existing VOD clips</h2><span className="count-badge">{discovery?.clips.length || 0}</span></div>
          {!discovery ? <div className="empty-highlights"><h3>Ready to discover.</h3><p>Public clip metadata works without the local AI engines.</p></div> : <><p className="public-result-count">{discovery.clips.length} {discovery.clips.length === 1 ? 'clip' : 'clips'} selected</p>{!discovery.clips.length && <div className="empty-highlights"><h3>No eligible clips found.</h3><p>No linked 30–60 second clips were found in the returned pages. Try another VOD or supply an authorized recording.</p></div>}<div className="public-clip-list">{discovery.clips.map(c => <article className="public-clip-card" key={c.id}>
            <button className="public-thumbnail" aria-label={`Preview ${c.title}`} onClick={() => setPreview(c)}>{c.thumbnail_url ? <img src={c.thumbnail_url} alt={`Thumbnail for ${c.title}`} loading="lazy" referrerPolicy="no-referrer" /> : <Clapperboard size={26} />}<span>{c.duration.toFixed(1)}s</span><Play size={18} /></button>
            <div className="public-clip-content"><h3>{c.title}</h3><small><Eye size={13} />{c.view_count.toLocaleString()} views · {c.duration.toFixed(1)}s</small><p>{c.explanation}</p><div className="public-clip-actions"><span>Metadata score {c.score}/100</span><a href={c.url} target="_blank" rel="noreferrer">Open on Twitch<ExternalLink size={13} /></a></div></div>
          </article>)}</div></>}
        </section>
      </div>
    </div> : <div className="workbench-grid">
      <div className="left-column">
        <section className="panel source-panel"><div className="panel-title"><Tv size={19} /><h2>Your Twitch account</h2><span className="panel-meta">VIEWER CLIPPING</span></div><div className="input-area">
          <p>{viewer?.connected ? `Connected as ${viewer.login}` : 'Connect your Twitch account to manually clip a live stream.'}</p>
          <button className="button secondary full" onClick={viewer?.connected ? disconnect : connect} disabled={!!busy || wait > 0 || !viewer?.configured}><Tv size={17} />{viewer?.connected ? 'Disconnect Twitch' : 'Connect Twitch'}</button>
          {viewer && !viewer.configured && <small>Set server Twitch credentials and register the callback URL described in README.md.</small>}
          <small>Requests permission to create clips as your viewer account. Channel clipping restrictions still apply.</small>
        </div></section>
        <section className="panel source-panel"><div className="panel-title"><Radio size={19} /><h2>Choose a live channel</h2></div><div className="input-area"><label htmlFor="live-channel">Twitch channel login or URL</label><input id="live-channel" value={channel} onChange={e => { setChannel(e.target.value); setLive(null); }} placeholder="caseoh_ or https://www.twitch.tv/kaicenat" /><button className="button secondary full" disabled={!!busy || wait > 0} onClick={checkLive}>Check live status<ArrowRight size={16} /></button>
          {live && <div className="vod-details"><strong className={live.live ? 'ready' : 'unavailable'}>{live.live ? 'LIVE NOW' : 'OFFLINE'}</strong><strong>{live.broadcaster.display_name}</strong><small>{live.stream ? `${live.stream.game_name} · ${live.stream.viewer_count.toLocaleString()} viewers` : 'Wait for the streamer to go live.'}</small><p>{live.stream?.title}</p></div>}
          <div className="notice"><ShieldCheck size={18} /><span>Capture a recent live moment with a manual click. Viewer clipping cannot create clips retrospectively from a VOD.</span></div>
          <label htmlFor="live-title">Clip title</label><input id="live-title" value={title} maxLength={100} onChange={e => setTitle(e.target.value)} /><label htmlFor="live-duration">Requested duration (seconds)</label><input id="live-duration" type="number" min="30" max="60" step="0.1" value={duration} onChange={e => setDuration(Number(e.target.value))} />
          <button className="button primary full" disabled={!!busy || wait > 0 || !viewer?.connected || !live?.live || !title.trim() || duration < 30 || duration > 60 || !Number.isFinite(duration)} onClick={create}><Clapperboard size={17} />Create live clip now<ArrowRight size={16} /></button><small>This publishes a clip on Twitch. The capture window is approximate and may be shorter near stream boundaries.</small>
        </div></section>
      </div>
      <div className="right-column">
        <section className="panel preview-panel"><div className="panel-title"><MonitorPlay size={18} /><h2>Live channel preview</h2></div><div className="preview-canvas">{live ? <iframe key={live.broadcaster.login} title="Twitch live preview" src={`https://player.twitch.tv/?channel=${encodeURIComponent(live.broadcaster.login)}&parent=${parent}&autoplay=false`} allowFullScreen /> : <div className="empty-preview"><div className="play-outline"><Radio size={25} /></div><h3>Catch a moment<br />as it happens.</h3><p>Check a channel, connect Twitch, then clip manually.</p></div>}</div></section>
        <section className="panel highlights-panel"><div className="panel-title"><Clapperboard size={19} /><h2>Your live Twitch clips</h2><span className="count-badge">{clips.length}</span></div>{!clips.length ? <div className="empty-highlights"><h3>No live clips yet.</h3><p>Clip IDs and links are saved locally for your connected account.</p></div> : <div className="public-clip-list">{clips.map(c => <article className="live-clip-card" key={c.id}><div className="highlight-heading"><h3>{c.title}</h3><span className={`status-pill ${c.status}`}>{c.status === 'ready' ? 'Published' : c.status === 'pending' ? 'Checking publication…' : 'Unconfirmed'}</span></div><small>{c.broadcasterName} · {c.duration.toFixed(1)}s · {new Date(c.createdAt).toLocaleString()}</small><p>Clip ID: {c.id}</p>{c.error && <p role="status">{c.error}</p>}<div className="official-links"><a href={c.url} target="_blank" rel="noreferrer">Open clip on Twitch<ExternalLink size={14} /></a><a href={c.editUrl} target="_blank" rel="noreferrer">Open Twitch editor<ExternalLink size={14} /></a></div></article>)}</div>}</section>
      </div>
    </div>}
    <footer className="page-footer"><span><ShieldCheck size={13} />Official Twitch APIs and embedded playback.</span><span>Vertical exports require an authorized recording.</span></footer>
  </div>;
}
