import { useEffect, useRef, useState } from 'react';
import { Activity, ArrowRight, Check, Clapperboard, Clock3, Copy, Download, ExternalLink, FileText, LoaderCircle, MonitorPlay, Play, ShieldCheck, Sparkles, Upload } from 'lucide-react';
import type { TimestampAnalysis, TimestampHighlight } from '../shared/types.js';
import { allTimestamps, analysisCsv, parseLivestreamSource } from '../shared/livestream.js';
import { api, ApiError } from './api.js';

export default function LivestreamAnalyzer({ onRecording }: { onRecording: () => void }) {
  const [url, setUrl] = useState('https://www.twitch.tv/videos/2895693134');
  const [attachment, setAttachment] = useState<File | null>(null); const [permission, setPermission] = useState(false);
  const [analysis, setAnalysis] = useState<TimestampAnalysis | null>(null); const [preview, setPreview] = useState<TimestampHighlight | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [copied, setCopied] = useState(''); const [copyText, setCopyText] = useState('');
  const [settings, setSettings] = useState<{ youtubeConfigured: boolean; transcriptModel: string } | null>(null);
  const [retryUntil, setRetryUntil] = useState(0); const [clock, setClock] = useState(Date.now());
  const fileInput = useRef<HTMLInputElement>(null); const wait = Math.max(0, Math.ceil((retryUntil - clock) / 1000));
  let platform: 'twitch' | 'youtube' | null = null;
  try { platform = parseLivestreamSource(url).platform; } catch { /* Validation is shown when Analyze is clicked. */ }
  useEffect(() => { void api<typeof settings>('/analyzer/status').then(setSettings).catch(() => {}); }, []);
  useEffect(() => { if (!wait) return; const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, [retryUntil, wait > 0]);
  const analyze = async () => {
    if (busy || wait) return; setError(''); setAnalysis(null); setPreview(null); setCopied(''); setCopyText(''); setBusy(true);
    try {
      parseLivestreamSource(url);
      if (attachment && !permission) throw new Error('Confirm permission to process this transcript.');
      if (attachment && attachment.size > 2 * 1024 ** 2) throw new Error('Transcript exceeds the 2 MB limit.');
      if (attachment) {
        const body = new FormData(); body.append('input', url); body.append('permission', 'true'); body.append('transcript', attachment);
        const response = await fetch('/api/analyzer/analyze', { method: 'POST', body });
        const data = await response.json() as TimestampAnalysis & { error?: string; retryAfter?: number };
        if (!response.ok) throw new ApiError(data.error || 'Transcript analysis failed.', response.status, Number(response.headers.get('Retry-After')) || data.retryAfter || 0);
        setAnalysis(data);
      } else setAnalysis(await api<TimestampAnalysis>('/analyzer/analyze', { input: url }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      if (e instanceof ApiError && e.retryAfter) { setRetryUntil(Date.now() + e.retryAfter * 1000); setClock(Date.now()); }
    } finally { setBusy(false); }
  };
  const copy = async (text: string, label: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(label); setCopyText(''); }
    catch { setCopyText(text); setCopied('Clipboard unavailable. Select and copy the text below.'); }
  };
  const download = (format: 'json' | 'csv') => {
    if (!analysis) return;
    const blob = new Blob([format === 'json' ? JSON.stringify(analysis, null, 2) : '\uFEFF' + analysisCsv(analysis)], { type: format === 'json' ? 'application/json' : 'text/csv;charset=utf-8' });
    const link = document.createElement('a'); const objectUrl = URL.createObjectURL(blob); link.href = objectUrl;
    link.download = `highlights-${analysis.source.platform}-${analysis.source.id}.${format}`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  };
  const embed = () => {
    if (!analysis?.source.embedAllowed) return null;
    const source = analysis.source; const start = preview ? Math.floor(preview.start) : 0;
    if (source.platform === 'youtube') return `https://www.youtube.com/embed/${source.id}?start=${start}&autoplay=0${preview ? `&end=${Math.floor(preview.end)}` : ''}`;
    return `https://player.twitch.tv/?video=v${source.id}&parent=${encodeURIComponent(window.location.hostname)}&autoplay=false&time=${Math.floor(start / 3600)}h${Math.floor(start / 60) % 60}m${start % 60}s`;
  };
  const playerUrl = embed();
  return <div className="timestamp-workbench">
    {error && <div className="alert error" role="alert"><span>{error}{wait > 0 && ` Retry in ${wait}s.`}</span></div>}
    <div className="workbench-grid">
      <div className="left-column">
        <section className="panel source-panel"><div className="panel-title"><Sparkles size={19} /><h2>Livestream highlight analyzer</h2><span className="panel-meta">TIMESTAMPS ONLY</span></div><div className="input-area analyzer-input">
          <label htmlFor="livestream-url">Source URL</label><input id="livestream-url" value={url} disabled={busy} onChange={e => { setUrl(e.target.value); setAnalysis(null); setPreview(null); setAttachment(null); setPermission(false); setCopied(''); setCopyText(''); if (fileInput.current) fileInput.current.value = ''; }} placeholder="Paste a Twitch VOD or YouTube livestream URL" />
          <small>Twitch VOD/schedule with vodID · YouTube watch/live/youtu.be</small>
          {platform && <div className="transcript-attachment"><label htmlFor="transcript-file"><FileText size={15} />Attach transcript</label><input ref={fileInput} id="transcript-file" type="file" accept=".srt,.vtt,.json,.txt" disabled={busy} onChange={e => { setAttachment(e.target.files?.[0] || null); setPermission(false); }} /><small>Let Ollama choose the best clip range from your transcript. SRT, VTT, JSON or timestamped TXT · up to 2 MB · original video timeline</small>{attachment && <label className="checkbox"><input type="checkbox" checked={permission} disabled={busy} onChange={e => setPermission(e.target.checked)} /><span>I have permission to process this transcript.</span></label>}{platform === 'youtube' && settings && !settings.youtubeConfigured && <div className="notice"><span>YouTube metadata needs a server YOUTUBE_API_KEY. See README.md for setup.</span></div>}</div>}
          <button className="button primary full" disabled={busy || !url.trim() || wait > 0 || (!!attachment && !permission)} onClick={() => void analyze()}>{busy ? <LoaderCircle size={17} className="spin" /> : <Sparkles size={17} />}Analyze Highlights<ArrowRight size={16} /></button>
          {busy && <div className="analyzer-progress" role="status"><Activity size={15} />{attachment ? 'Ollama is analyzing context and choosing natural clip boundaries. Long transcripts can take time…' : platform === 'youtube' ? 'Resolving video metadata…' : 'Resolving VOD metadata and searching existing public clips…'}</div>}
          <div className="notice"><ShieldCheck size={18} /><span>{attachment ? 'Ollama uses the supplied transcript to choose a complete moment’s start and end. Review the original before clipping.' : platform === 'youtube' ? 'Highlights require a transcript you are permitted to use. Metadata alone does not establish what happened in the video.' : 'Attach a transcript for Ollama to choose clip ranges. Without one, results use existing Twitch clip offsets and metadata scores.'}</span></div>
          <button className="text-button" onClick={onRecording}><Upload size={14} />Use an authorized recording<ArrowRight size={14} /></button>
        </div></section>
        <section className="panel analysis-panel"><div className="panel-title"><Clock3 size={18} /><h2>Manual clipping workflow</h2></div><div className="recipe-grid"><div><span>HIGHLIGHTS</span><strong>Up to 8</strong></div><div><span>CLIP RANGE</span><strong>AI chosen</strong></div><div><span>OUTPUT</span><strong>Seek times</strong></div></div><p className="analyzer-help">Ollama reviews a shortlist across your transcript and chooses natural start and end times, keeping setup and payoff together with no fixed clip length. Review the suggested range in the original stream, then clip it yourself. Existing Twitch clips keep their actual duration.</p></section>
        {analysis && <section className="panel public-summary"><div className="panel-title"><ShieldCheck size={18} /><h2>Evidence & confidence</h2></div><div className="analysis-indicators"><span>{analysis.dataSource === 'existing-clips' ? 'Existing public clips' : analysis.dataSource === 'transcript' ? 'User-provided transcript' : 'No content evidence'}</span><span>{analysis.confidence === 'metadata-only' ? 'Content confidence: limited metadata' : analysis.confidence === 'transcript-supported' ? 'Content confidence: text-supported' : 'Confidence unavailable'}</span></div><p>{analysis.confidenceExplanation}</p>{analysis.scan && <small>{analysis.scan.scanned} clip records · {analysis.scan.pages} pages · {analysis.scan.matched} linked clips · {analysis.scan.missingOffsets} missing offsets</small>}{analysis.dataSource === 'transcript' && <small>Local Ollama · {settings?.transcriptModel || 'llama3.2'}</small>}</section>}
      </div>
      <div className="right-column">
        <section className="panel preview-panel"><div className="panel-title"><MonitorPlay size={18} /><h2>Original livestream preview</h2></div><div className="preview-canvas">{playerUrl ? <iframe key={`${analysis?.source.id}:${preview?.id || 'full'}`} title="Original livestream preview" src={playerUrl} allowFullScreen /> : <div className="empty-preview"><div className="play-outline"><Play size={25} /></div><h3>Find the timestamps.<br />Clip the original.</h3><p>{analysis && !analysis.source.embedAllowed ? 'Embedded playback is unavailable. Open the original video to review it.' : 'Paste a source URL to find evidence-supported moments.'}</p></div>}</div>{analysis && <div className="preview-footer"><div><span className="green-dot" /><span>{analysis.source.creator} · {analysis.source.title}</span></div><a href={preview?.originalUrl || analysis.source.url} target="_blank" rel="noreferrer">Open Original<ExternalLink size={14} /></a></div>}{preview && <p className="analyzer-seek-note">Seek to {preview.startTime}; end at {preview.endTime}. Playback availability depends on the platform. Seek links use whole seconds; copy the exact time for fractional boundaries.</p>}</section>
        <section className="panel highlights-panel"><div className="panel-title"><Clapperboard size={19} /><h2>Highlight timestamps</h2><span className="count-badge">{analysis?.highlights.length || 0}</span></div>
          {!analysis ? <div className="empty-highlights"><div className="stacked-cards"><div /><div /><div><Clock3 size={22} /></div></div><h3>Your best moments, with evidence.</h3><p>Analyze a VOD’s existing clips or a supplied transcript.<br />Find up to eight strong, non-overlapping moments.</p></div> : <>
            <p className="public-result-count">{analysis.highlights.length} highlights found</p>
            {analysis.status === 'unavailable' && <div className="empty-highlights"><h3>Highlights unavailable</h3><p>{analysis.warnings.at(-1) || 'No qualifying timestamped evidence is available for this source.'}</p></div>}
            <div className="timestamp-list">{analysis.highlights.map((h, index) => <article className="timestamp-card" key={h.id}><div className="highlight-heading"><span className="clip-number">{String(index + 1).padStart(2, '0')}</span><h3>{h.title}</h3><span className="score">{h.score}<small>/100</small></span></div><div className="timestamp-range"><Clock3 size={15} /><strong>{h.startTime}</strong><ArrowRight size={13} /><strong>{h.endTime}</strong><span>{Number(h.duration.toFixed(3))}s</span></div><p>{h.description}</p><div className="timestamp-meta"><span>{h.dataSource === 'existing-clips' ? 'Metadata score' : 'Transcript score'} · {h.viewCount === null ? 'No audiovisual analysis' : `${h.viewCount.toLocaleString()} clip views`}</span>{h.dataSource === 'existing-clips' && h.duration < 30 && <span className="short-clip-label">Actual shorter clip · no padding</span>}</div><div className="timestamp-actions"><button className="button secondary small" aria-label={`Preview ${h.title}`} onClick={() => setPreview(h)}><Play size={14} />Preview</button><a className="button secondary small" href={h.originalUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} />{analysis.source.platform === 'twitch' ? 'Open VOD at Timestamp' : 'Open Original'}</a><button className="button secondary small" aria-label={`Copy timestamp for ${h.title}`} onClick={() => void copy(`${h.startTime} – ${h.endTime}`, 'Timestamp copied')}><Copy size={14} />Copy Timestamp</button>{h.clipUrl && <a href={h.clipUrl} target="_blank" rel="noreferrer" className="text-button">Original Twitch clip<ExternalLink size={13} /></a>}</div>{h.transcript && <details><summary>Transcript evidence</summary><p>{h.transcript}</p></details>}</article>)}</div>
            <div className="timestamp-exports"><button className="button secondary small" disabled={!analysis.highlights.length} onClick={() => void copy(allTimestamps(analysis), 'All timestamps copied')}><Copy size={14} />Copy All Timestamps</button><button className="button secondary small" onClick={() => download('json')}><Download size={14} />Export JSON</button><button className="button secondary small" onClick={() => download('csv')}><Download size={14} />Export CSV</button></div>
          </>}
          {copied && <div className="copy-status" role="status"><Check size={15} />{copied}</div>}{copyText && <textarea className="copy-fallback" aria-label="Copyable timestamps" value={copyText} readOnly onFocus={e => e.currentTarget.select()} />}
          {!!analysis?.warnings.length && <details className="analysis-notes"><summary>Analysis limitations</summary>{analysis.warnings.map(w => <p key={w}>{w}</p>)}</details>}
        </section>
      </div>
    </div>
    <footer className="page-footer"><span><ShieldCheck size={13} />Timestamp analysis only. No platform video downloads or automatic exports.</span><span>Review the evidence. Clip manually.</span></footer>
  </div>;
}
