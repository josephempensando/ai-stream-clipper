import { useEffect, useRef, useState } from 'react';
import { Mic, RefreshCw, Play, ArrowDownToLine, X } from 'lucide-react';
import { captionStyleSchema } from '../shared/retention.js';
import type { StoryJob, StorySettings, StorySummary, StoryReadiness, VoicePreview } from '../shared/story.js';
import { createStorySettingsSchema, storyStats, storyPreviewExcerpt } from '../shared/story.js';
import CaptionSettings from './CaptionSettings.js';
import { storyApi, uploadStory } from './story-api.js';
import './story.css';
const initial: StorySettings = { script: '', voiceId: 'en_US-lessac-medium', speed: 1, subtitles: captionStyleSchema.parse({}), layout: 'crop', cropX: 0.5, fitMode: 'auto', backgroundMuted: true, backgroundGainDb: -22, musicGainDb: -22, rights: { footagePermission: true } };
const duration = (seconds: number) => `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
const terminal = (job: StoryJob) => ['complete', 'error', 'cancelled'].includes(job.status);
export default function StoryNarrator() {
  const [settings, setSettings] = useState<StorySettings>(initial); const [permission, setPermission] = useState(false);
  const [musicPermission, setMusicPermission] = useState(false); const [license, setLicense] = useState<'owned' | 'licensed'>('licensed'); const [provenance, setProvenance] = useState('');
  const [video, setVideo] = useState<File | null>(null); const [music, setMusic] = useState<File | null>(null);
  const [readiness, setReadiness] = useState<StoryReadiness | null>(null); const [jobs, setJobs] = useState<StorySummary[]>([]); const [job, setJob] = useState<StoryJob | null>(null);
  const [busy, setBusy] = useState(''); const [uploadPercent, setUploadPercent] = useState(0); const [error, setError] = useState('');
  const [voicePreview, setVoicePreview] = useState<VoicePreview | null>(null); const [previewing, setPreviewing] = useState(false); const [showVideo, setShowVideo] = useState(false);
  const mounted = useRef(true); const draftTouched = useRef(false); const upload = useRef<AbortController | null>(null); const previewId = useRef(''); const previewVersion = useRef(0); const previewAbort = useRef<AbortController | null>(null); const player = useRef<HTMLVideoElement>(null);
  const working = !!job && !terminal(job); const disabled = !!busy || working; const stats = storyStats(settings.script, settings.speed);
  const enginesReady = readiness?.piper && readiness.ffmpeg && readiness.ffprobe && (!settings.subtitles.enabled || readiness.whisper) && readiness.voices.some(v => v.id === settings.voiceId && v.installed);
  const currentSettings = (): StorySettings => ({ ...settings, rights: { footagePermission: permission as true, ...((music || job?.musicName) ? { music: { permission: musicPermission as true, license, provenance } } : {}) } });
  const valid = createStorySettingsSchema(readiness?.maxScriptCharacters).safeParse(currentSettings()).success;
  const set = <K extends keyof StorySettings>(key: K, value: StorySettings[K]) => { draftTouched.current = true; setSettings(s => ({ ...s, [key]: value })); };
  const refreshJobs = () => storyApi<StorySummary[]>('').then(data => { if (mounted.current) setJobs(data); });
  const attempt = async (label: string, operation: () => Promise<void>) => { setError(''); setBusy(label); try { await operation(); } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); } finally { if (mounted.current) setBusy(''); } };
  const clearVoice = () => { previewVersion.current++; previewAbort.current?.abort(); if (previewId.current) { void storyApi(`/voice-previews/${previewId.current}`, undefined, 'DELETE').catch(() => {}); previewId.current = ''; } setVoicePreview(null); setPreviewing(false); };
  useEffect(() => {
    mounted.current = true; const controller = new AbortController();
    void storyApi<StoryReadiness>('/voices', undefined, 'GET', controller.signal).then(data => { if (mounted.current) { setReadiness(data); setSettings(s => draftTouched.current ? s : { ...s, voiceId: data.defaultVoiceId }); } }).catch(e => { if (!controller.signal.aborted) setError(String(e)); });
    void refreshJobs().catch(e => { if (mounted.current) setError(String(e)); });
    return () => { mounted.current = false; controller.abort(); upload.current?.abort(); previewVersion.current++; previewAbort.current?.abort(); if (previewId.current) void storyApi(`/voice-previews/${previewId.current}`, undefined, 'DELETE').catch(() => {}); };
  }, []);
  useEffect(() => { clearVoice(); }, [settings.voiceId, settings.speed]);
  useEffect(() => {
    if (!job || terminal(job)) { void refreshJobs().catch(() => {}); return; }
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { try { const next = await storyApi<StoryJob>(`/${job.id}`, undefined, 'GET', controller.signal); if (!controller.signal.aborted) { setJob(next); if (!terminal(next)) timer = setTimeout(() => void poll(), 1500); } } catch (e) { if (!controller.signal.aborted) { setError(String(e)); timer = setTimeout(() => void poll(), 3000); } } };
    timer = setTimeout(() => void poll(), 1000); return () => { controller.abort(); clearTimeout(timer); };
  }, [job?.id, job ? terminal(job) : true]);
  const previewVoice = () => void (async () => {
    setError('');
    clearVoice(); const version = previewVersion.current; const controller = new AbortController(); previewAbort.current = controller; setPreviewing(true);
    try {
      // Keep creation observable so a superseded accepted job can still be deleted.
      const created = await storyApi<VoicePreview>('/voice-previews', { text: storyPreviewExcerpt(settings.script) || 'Welcome to your story. Every word has a place, and every voice brings it to life.', voiceId: settings.voiceId, speed: settings.speed });
      if (!mounted.current || version !== previewVersion.current) { await storyApi(`/voice-previews/${created.id}`, undefined, 'DELETE'); return; }
      previewId.current = created.id; let current = created;
      while (!['complete', 'cancelled', 'error'].includes(current.status)) {
        await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => { controller.signal.removeEventListener('abort', aborted); resolve(); }, 700); const aborted = () => { clearTimeout(timer); reject(new DOMException('Preview cancelled.', 'AbortError')); }; controller.signal.addEventListener('abort', aborted, { once: true }); if (controller.signal.aborted) aborted(); });
        current = await storyApi<VoicePreview>(`/voice-previews/${created.id}`, undefined, 'GET', controller.signal);
      }
      if (version === previewVersion.current && mounted.current) { if (current.error) throw new Error(current.error.message); setVoicePreview(current); }
    } catch (e) { if (!controller.signal.aborted && version === previewVersion.current && mounted.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (version === previewVersion.current) setPreviewing(false); }
  })();
  const generate = () => void attempt('Uploading background', async () => {
    if (!video) throw new Error('Choose an MP4 background first.'); const parsed = createStorySettingsSchema(readiness?.maxScriptCharacters).parse(currentSettings());
    const controller = new AbortController(); upload.current = controller; const form = new FormData(); form.append('settings', JSON.stringify(parsed)); form.append('background', video); if (music) form.append('music', music);
    setUploadPercent(0); setShowVideo(false); const next = await uploadStory(form, controller.signal, (loaded, total) => setUploadPercent(Math.round(loaded / total * 100))); setJob(next); upload.current = null; await refreshJobs();
  });
  const restore = (id: string) => { draftTouched.current = true; void attempt('Opening story', async () => { const next = await storyApi<StoryJob>(`/${id}`); setJob(next); setSettings(next.settings); setPermission(next.settings.rights.footagePermission); setMusicPermission(!!next.settings.rights.music?.permission); setLicense(next.settings.rights.music?.license || 'licensed'); setProvenance(next.settings.rights.music?.provenance || ''); setVideo(null); setMusic(null); setShowVideo(!!next.successfulAttemptId); }); };
  const cancel = () => { if (upload.current && busy === 'Uploading background') { upload.current.abort(); return; } if (job) void attempt('Cancelling', async () => { setJob(await storyApi<StoryJob>(`/${job.id}/cancel`, {})); }); };
  return <section className="story-narrator" aria-label="Story Narrator editor">
    <div className="story-toolbar"><label>Saved stories<select aria-label="Saved stories" value={job?.id || ''} disabled={disabled} onChange={e => { if (e.target.value) restore(e.target.value); }}><option value="">New story</option>{jobs.map(j => <option value={j.id} key={j.id}>{j.title} · {j.status}</option>)}</select></label><button className="button secondary" disabled={disabled} onClick={() => { draftTouched.current = false; setJob(null); setSettings({ ...initial, voiceId: readiness?.defaultVoiceId || initial.voiceId }); setPermission(false); setMusicPermission(false); setProvenance(''); setVideo(null); setMusic(null); setShowVideo(false); clearVoice(); }}>New story</button></div>
    {error && <div className="alert error" role="alert">{error}</div>}
    {readiness && !enginesReady && <div className="notice" role="status">Local setup needed: {!readiness.piper ? 'Piper · ' : ''}{!readiness.whisper && settings.subtitles.enabled ? 'Whisper · ' : ''}{!readiness.ffmpeg || !readiness.ffprobe ? 'FFmpeg · ' : ''}{!readiness.voices.some(v => v.installed && v.id === settings.voiceId) ? 'selected stock voice · ' : ''}{readiness.setupError || 'See README → Story Narrator setup.'}</div>}
    <div className="story-columns"><div className="panel story-form"><fieldset disabled={disabled}>
      <label>Story / script<textarea aria-label="Story / script" rows={12} maxLength={readiness?.maxScriptCharacters || 30000} value={settings.script} onChange={e => set('script', e.target.value)} placeholder="Paste your story exactly as it should be narrated…" /></label>
      <p className="story-stats">{stats.words} words · {stats.characters} characters · Estimated {duration(stats.estimatedSeconds)} at {settings.speed.toFixed(2)}×</p><small>The supplied text is spoken as written. Final duration is measured from the audio.</small>
      <div className="story-controls"><label>Narration voice<select aria-label="Narration voice" value={settings.voiceId} onChange={e => set('voiceId', e.target.value)}>{!readiness?.voices.length && <option value={settings.voiceId}>Lessac · setup required</option>}{readiness?.voices.map(v => <option value={v.id} disabled={!v.installed} key={v.id}>{v.label}{v.installed ? '' : ' · not installed'}</option>)}</select></label><label>Speaking speed<input aria-label="Speaking speed" type="range" min="0.75" max="1.5" step="0.05" value={settings.speed} onChange={e => set('speed', Number(e.target.value))} /><span>{settings.speed.toFixed(2)}×</span></label></div>
      <small>Childlike is a pitch-adjusted stock voice. Preview any voice before generating.</small>
    </fieldset><button className="button secondary" disabled={!enginesReady || previewing || working || busy === 'Uploading background'} onClick={previewVoice}><Mic size={16} />{previewing ? 'Synthesizing preview…' : 'Preview voice'}</button>
    {voicePreview?.audioUrl && <small>Voice preview excerpt · up to 300 characters</small>}
    {voicePreview?.audioUrl && <audio aria-label="Narration voice preview" controls autoPlay src={voicePreview.audioUrl} />}
    <fieldset disabled={disabled}>
      <label>Background MP4<input type="file" accept="video/mp4,.mp4" onChange={e => { setVideo(e.target.files?.[0] || null); if (job) setJob(null); }} /></label>{job && <small>Retained footage: {job.backgroundName}</small>}
      <label className="checkbox"><input type="checkbox" checked={permission} onChange={e => setPermission(e.target.checked)} />I have permission to use this footage.</label>
      <div className="story-controls"><label>Video framing<select value={settings.layout} onChange={e => set('layout', e.target.value as StorySettings['layout'])}><option value="crop">Fill vertical frame</option><option value="blur">Fit with blurred background</option></select></label><label>Background fit<select value={settings.fitMode} onChange={e => set('fitMode', e.target.value as StorySettings['fitMode'])}><option value="auto">Automatic · trim, gently slow or loop</option><option value="loop">Loop with dissolve</option><option value="slow-loop">Slow to 0.75× then loop</option></select></label></div>
      {settings.layout === 'crop' && <label>Horizontal framing<input type="range" min="0" max="1" step="0.05" value={settings.cropX} onChange={e => set('cropX', Number(e.target.value))} /></label>}
      <label className="checkbox"><input type="checkbox" checked={settings.backgroundMuted} onChange={e => set('backgroundMuted', e.target.checked)} />Mute original background audio</label>
      <label>Background volume ({settings.backgroundGainDb} dB)<input type="range" min="-45" max="0" value={settings.backgroundGainDb} disabled={settings.backgroundMuted} onChange={e => set('backgroundGainDb', Number(e.target.value))} /></label>
      <label>Optional licensed music<input type="file" accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac" disabled={!!job} onChange={e => setMusic(e.target.files?.[0] || null)} /></label>{job?.musicName && <small>Retained music: {job.musicName}</small>}
      {(music || job?.musicName) && <><label>Music license<select value={license} onChange={e => setLicense(e.target.value as 'owned' | 'licensed')}><option value="owned">I own this music</option><option value="licensed">Licensed for this use</option></select></label><label>Music provenance<textarea rows={2} value={provenance} onChange={e => setProvenance(e.target.value)} placeholder="Source, license and permitted use" /></label><label className="checkbox"><input type="checkbox" checked={musicPermission} onChange={e => setMusicPermission(e.target.checked)} />I have permission to use this music.</label><label>Music volume ({settings.musicGainDb} dB)<input type="range" min="-45" max="0" value={settings.musicGainDb} onChange={e => set('musicGainDb', Number(e.target.value))} /></label></>}
    </fieldset>
    <details open><summary>Animated subtitles</summary><CaptionSettings value={settings.subtitles} disabled={disabled} onChange={value => set('subtitles', value)} /><small>Karaoke highlights spoken words using Whisper timestamps. Plain and fade keep the same timing.</small></details>
    <p className="story-privacy">Stock local voices only. Use authorized material. Drafts stay on this machine until you choose to share them.</p>
    <div className="story-actions">{!job && <button className="button primary" disabled={disabled || !valid || !video || !enginesReady} onClick={generate}>Generate Video</button>}{job && <button className="button primary" disabled={disabled || !valid || !enginesReady} onClick={() => void attempt('Starting regeneration', async () => { setJob(await storyApi<StoryJob>(`/${job.id}/regenerate`, currentSettings())); })}><RefreshCw size={16} />Regenerate</button>}{(working || busy === 'Uploading background') && <button className="button secondary" disabled={job?.status === 'cancelling'} onClick={cancel}><X size={16} />Cancel</button>}</div>
    </div><div className="story-output panel">
      <h2>Your story video</h2>{busy === 'Uploading background' && <><p>Uploading: {uploadPercent}%{uploadPercent === 100 ? ' · validating media and local engines' : ''}</p><progress max={100} value={uploadPercent} /></>}
      {job && <><p role="status">{job.status} · {job.progress.stage}</p><progress max={100} value={job.progress.percent} /><p>{Math.floor(job.progress.percent)}% · {job.progress.completed.toFixed(1)} / {job.progress.total.toFixed(1)}</p>{job.actualDuration && <p>Measured narration: {duration(job.actualDuration)} ({job.actualDuration.toFixed(2)} seconds)</p>}{job.error && <p role="alert">{job.error.message}</p>}{job.warnings.map((w, i) => <p key={i}>{w}</p>)}</>}
      {job?.previewUrl ? <>{job.status !== 'complete' && <p>Previous successful draft is available while this attempt processes.</p>}<div className="story-actions"><button className="button secondary" onClick={() => { setShowVideo(true); void player.current?.play(); }}><Play size={16} />Preview</button><a className="button primary" href={job.downloadUrl}><ArrowDownToLine size={16} />Download MP4</a>{job.captionsUrl && <a className="button secondary" href={job.captionsUrl}>Download subtitles</a>}</div>{showVideo && <video ref={player} controls playsInline src={`${job.previewUrl}?draft=${job.successfulAttemptId}`} />}</> : <p>Generate a vertical 1080 × 1920 video with synchronized narration and captions. Your story determines the length.</p>}
    </div></div>
  </section>;
}
