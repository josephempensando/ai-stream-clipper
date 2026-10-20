import { useEffect, useState } from 'react';
import { ArrowDownToLine, RefreshCw, Sparkles } from 'lucide-react';
import type { ClipEdit, Job, Transcript } from '../shared/types.js';
import { beatNames } from '../shared/retention.js';
import type { AudioAsset, ClipRetention, RetentionSettings } from '../shared/retention.js';
import { api } from './api.js';
import './retention.css';
import CaptionSettings from './CaptionSettings.js';
import { CLIP_MIN_DURATION, meetsMinimumDuration } from '../shared/duration.js';

interface Props {
  job: Job | null; settings: RetentionSettings; onSettings: (value: RetentionSettings) => void;
  edits: Record<string, ClipEdit>; onEdit: (edit: ClipEdit) => void; selected: string[];
  onJob: (job: Job) => void; onRegenerate: () => void; onExport: () => void; disabled: boolean; exportDisabled: boolean;
}
const stamp = (n: number) => `${n.toFixed(2)}s`;
export default function RetentionEditor({ job, settings, onSettings, edits, onEdit, selected, onJob, onRegenerate, onExport, disabled, exportDisabled }: Props) {
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [message, setMessage] = useState(''); const [uploading, setUploading] = useState(false);
  const [kind, setKind] = useState<'music' | 'sfx'>('music'); const [license, setLicense] = useState<'owned' | 'licensed'>('owned');
  const [provenance, setProvenance] = useState(''); const [permission, setPermission] = useState(false);
  const [focus, setFocus] = useState('');
  const set = <K extends keyof RetentionSettings>(key: K, value: RetentionSettings[K]) => onSettings({ ...settings, [key]: value });
  useEffect(() => {
    let active = true; setTranscript(null);
    if (job?.highlights.length && !['queued', 'analyzing'].includes(job.status)) void api<Transcript>(`/jobs/${job.id}/transcript`).then(t => { if (active) setTranscript(t); }).catch(e => { if (active) setMessage(String(e)); });
    return () => { active = false; };
  }, [job?.id, job?.status]);
  useEffect(() => { setFocus(''); setMessage(''); }, [job?.id]);
  const upload = async (file: File) => {
    if (!job) return; setMessage(''); setUploading(true);
    try {
      const form = new FormData(); form.append('audio', file); form.append('kind', kind); form.append('license', license); form.append('provenance', provenance); form.append('permission', String(permission));
      const response = await fetch(`/api/jobs/${job.id}/audio`, { method: 'POST', body: form });
      const data = await response.json() as AudioAsset & { error?: string }; if (!response.ok) throw new Error(data.error || 'Audio upload failed.');
      onJob({ ...job, audioAssets: [...job.audioAssets || [], data] }); set(kind === 'music' ? 'musicId' : 'sfxId', data.id);
      setMessage(`${data.name} is ready. Provenance saved with this project.`);
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); } finally { setUploading(false); }
  };
  const h = job?.highlights.find(h => h.id === focus) || job?.highlights[0];
  const edit = h ? edits[h.id] || { id: h.id, start: h.start, end: h.end } : undefined;
  const adjust = (value: Partial<ClipRetention>) => { if (edit) onEdit({ ...edit, adjustments: { captions: [], ...edit.adjustments, ...value } }); };
  const corrected = (start: number, end: number, text: string) => edit?.adjustments?.captions.find(c => c.start === start && c.end === end)?.text ?? text;
  const correct = (start: number, end: number, text: string) => {
    const values = (edit?.adjustments?.captions || []).filter(c => c.start !== start || c.end !== end);
    if (text.trim()) values.push({ start, end, text }); adjust({ captions: values });
  };
  const sourceCaptions = (transcript?.segments || h?.cues || []).filter(c => edit && c.start >= edit.start && c.end <= edit.end);
  const output = job?.outputs.find(o => o.id === h?.id);
  return <section className="panel retention-panel" aria-label="AI Retention Editor">
    <div className="panel-title"><Sparkles size={19} /><h2>AI Retention Editor</h2><span className="panel-meta">SOURCE → STORY → EDIT</span></div>
    <p>Keep the full thought. Minimum 30 seconds; AI chooses the natural ending with no maximum. Review every draft before sharing.</p>
    <fieldset disabled={disabled || uploading}>
      <div className="retention-controls">
        <label className="checkbox"><input type="checkbox" checked={settings.autoEdit} onChange={e => set('autoEdit', e.target.checked)} />Auto Edit</label>
        <label>Hook strategy<select value={settings.hookStrategy} onChange={e => set('hookStrategy', e.target.value as RetentionSettings['hookStrategy'])}><option value="auto">Automatic · source evidence</option><option value="verbal">Verbal · strong source quote</option><option value="visual">Visual · review source opening</option><option value="emotional">Emotional · supported speech</option></select></label>
        <label>Frame rate<select aria-label="Frame rate" value={settings.fps} onChange={e => set('fps', Number(e.target.value) as 30 | 60)}><option value="30">30 FPS</option><option value="60">60 FPS · for high motion sources</option></select></label>
        <label className="checkbox"><input type="checkbox" checked={settings.hookText} onChange={e => set('hookText', e.target.checked)} />Verbatim hook overlay</label>
        <label className="checkbox"><input type="checkbox" checked={settings.patternInterrupts} onChange={e => set('patternInterrupts', e.target.checked)} />Subtle pattern interrupts</label>
        <label className="checkbox"><input type="checkbox" checked={settings.trimPauses} onChange={e => set('trimPauses', e.target.checked)} />Shorten approved pauses</label>
      </div>
      <details open><summary>Animated captions</summary><CaptionSettings value={settings.captions} onChange={value => set('captions', value)} disabled={disabled || uploading} /><small>Margins leave space at the bottom and right. Check the destination app before publishing. Older segment-only transcripts use plain captions.</small></details>
      <details><summary>Sound design & licensed audio</summary><div className="retention-controls">
        <label className="checkbox"><input type="checkbox" checked={settings.normalize} onChange={e => set('normalize', e.target.checked)} />Normalize dialogue</label>
        <label>Dialogue target (LUFS)<input type="number" min="-24" max="-12" value={settings.dialogueLufs} onChange={e => set('dialogueLufs', Number(e.target.value))} /></label>
        <label>Background music<select value={settings.musicId || ''} onChange={e => set('musicId', e.target.value || null)}><option value="">Disabled</option>{job?.audioAssets?.filter(a => a.kind === 'music').map(a => <option key={a.id} value={a.id}>{a.name} · {a.license}</option>)}</select></label>
        <label>Music gain (dB)<input type="number" min="-45" max="0" value={settings.musicGainDb} onChange={e => set('musicGainDb', Number(e.target.value))} /></label>
        <label>Transition SFX<select value={settings.sfxId || ''} onChange={e => set('sfxId', e.target.value || null)}><option value="">Disabled</option>{job?.audioAssets?.filter(a => a.kind === 'sfx').map(a => <option key={a.id} value={a.id}>{a.name} · {a.license}</option>)}</select></label>
        <label>SFX gain (dB)<input type="number" min="-40" max="0" value={settings.sfxGainDb} onChange={e => set('sfxGainDb', Number(e.target.value))} /></label>
      </div><p>Music ducks beneath dialogue. SFX align to approved emphasis edits. Listen to the rendered mix.</p>
      {job && <div className="audio-upload"><div className="retention-controls"><label>Asset type<select value={kind} onChange={e => setKind(e.target.value as typeof kind)}><option value="music">Music</option><option value="sfx">SFX</option></select></label><label>Rights<select value={license} onChange={e => setLicense(e.target.value as typeof license)}><option value="owned">I own this recording</option><option value="licensed">I have a license</option></select></label></div><label>Provenance / license record<input value={provenance} onChange={e => setProvenance(e.target.value)} placeholder="Creator, source, license and permitted use" /></label><label className="checkbox"><input type="checkbox" checked={permission} onChange={e => setPermission(e.target.checked)} />I have permission to use this audio in the draft.</label><input aria-label="Upload owned or licensed audio" type="file" accept="audio/*" disabled={!permission || provenance.trim().length < 5} onChange={e => { if (e.target.files?.[0]) void upload(e.target.files[0]); e.target.value = ''; }} /><small>Up to 100 MB. Publishing clearance still requires the project rights review.</small></div>}
      </details>
      <div className="retention-controls"><label>Ending strategy<select value={settings.ending} onChange={e => set('ending', e.target.value as RetentionSettings['ending'])}><option value="natural">Natural payoff</option><option value="loop">Seamless loop · only when supported</option><option value="cta">One relevant CTA</option></select></label>{settings.ending === 'cta' && <label>One CTA<input maxLength={100} value={settings.cta} onChange={e => set('cta', e.target.value)} placeholder="One relevant invitation" /></label>}</div>
    </fieldset>
    {(uploading || message) && <p role="status">{uploading ? 'Uploading and checking audio…' : message}</p>}
    {!!job?.highlights.length && <>
      <div className="retention-actions"><label>Review clip<select aria-label="Retention clip" value={h?.id || ''} onChange={e => setFocus(e.target.value)}>{job.highlights.map(h => <option key={h.id} value={h.id}>{h.title}</option>)}</select></label><button className="button secondary" disabled={disabled} onClick={onRegenerate}><RefreshCw size={15} />Regenerate</button><button className="button primary" disabled={disabled || exportDisabled || !selected.length} onClick={onExport}><ArrowDownToLine size={15} />Export selected</button></div>
      {h && edit && <div className="retention-review">
        <div className="retention-controls"><label>Selected start (seconds)<input type="number" list="retention-cue-starts" min={0} max={Math.max(0, edit.end - CLIP_MIN_DURATION)} aria-invalid={!meetsMinimumDuration(edit.end - edit.start)} step="0.01" value={edit.start} disabled={disabled} onChange={e => onEdit({ ...edit, start: Number(e.target.value) })} /></label><label>Selected end (seconds)<input type="number" list="retention-cue-ends" min={edit.start + CLIP_MIN_DURATION} aria-invalid={!meetsMinimumDuration(edit.end - edit.start)} max={job.media.duration} step="0.01" value={edit.end} disabled={disabled} onChange={e => onEdit({ ...edit, end: Number(e.target.value) })} /></label><span>{stamp(edit.end - edit.start)} source · {h.retention ? `${stamp(h.retention.edl.duration)} planned` : 'Regenerate for narrative & EDL'}</span></div>
        <datalist id="retention-cue-starts">{transcript?.segments.map((c, i) => <option key={i} value={c.start}>{c.text.slice(0, 70)}</option>)}</datalist>
        <datalist id="retention-cue-ends">{transcript?.segments.map((c, i) => <option key={i} value={c.end}>{c.text.slice(0, 70)}</option>)}</datalist>
        <p>AI-selected duration: {stamp(h.aiSelectedDuration ?? h.end - h.start)}. Minimum 30 seconds, including after pause shortening.</p>{!meetsMinimumDuration(edit.end - edit.start) && <p role="alert">This edit is below 30 seconds. Review meaningful context before export.</p>}<small>Timing suggestions use complete source transcript boundaries. Retain the full question and answer, then Regenerate to reassess the edited interval.</small>
        {h.retention && <><p className={h.retention.narrative.coherent ? 'ready' : 'unavailable'}>{h.retention.narrative.coherent ? 'Model assessment: complete narrative' : 'Model assessment: incomplete narrative · ranked lower'}</p><div className="narrative-grid">{beatNames.map(name => { const beat = h.retention!.narrative.beats[name]; return <article key={name}><strong>{name === 'ending' ? 'Natural ending' : name}</strong>{beat ? <><small>{stamp(beat.start)} → {stamp(beat.end)}</small><blockquote>{beat.quote}</blockquote></> : <p>No supported beat identified.</p>}</article>; })}</div><p>Opening 1–3 seconds: {h.retention.narrative.firstSeconds.quote || 'No word-level transcript available. Review the source opening.'}</p><p>{h.retention.narrative.reason}</p><details><summary>Exact edit decisions & recommendations</summary>{h.retention.edl.recommendations.map((r, i) => <p key={i}>{r}</p>)}<table><thead><tr><th>Source time</th><th>Edit</th><th>Reason</th></tr></thead><tbody>{h.retention.edl.actions.map((a, i) => <tr key={i}><td>{stamp(a.start)}–{stamp(a.end)}</td><td>{a.type}</td><td>{a.reason}</td></tr>)}</tbody></table><small>These are analysis-time decisions. Export writes the final EDL with your controls and overrides.</small></details></>}
        <div className="retention-controls"><label className="checkbox"><input type="checkbox" checked={edit.adjustments?.patternInterrupts ?? settings.patternInterrupts} disabled={disabled} onChange={e => adjust({ patternInterrupts: e.target.checked })} />Pattern interrupts for this clip</label><label>Clip ending<select aria-label="Clip ending" disabled={disabled} value={edit.adjustments?.ending || settings.ending} onChange={e => adjust({ ending: e.target.value as RetentionSettings['ending'] })}><option value="natural">Natural payoff</option><option value="loop" disabled={!h.retention?.narrative.loop}>Seamless loop</option><option value="cta">One CTA</option></select></label></div>
        <div className="retention-previews"><div><strong>Before · source</strong><video key={`${job.id}/${h.id}/${h.start}`} controls preload="metadata" src={`/api/jobs/${job.id}/media#t=${edit.start},${edit.end}`} onLoadedMetadata={e => { e.currentTarget.currentTime = edit.start; }} onTimeUpdate={e => { if (e.currentTarget.currentTime >= edit.end) e.currentTarget.pause(); }} /></div><div><strong>After · latest export</strong>{output && job.status === 'complete' ? <video controls preload="metadata" src={`/api/jobs/${job.id}/preview/${output.file}?v=${job.progress}`} /> : <p>Export to preview the actual edited video.</p>}</div></div>
        <details><summary>Correct subtitles in this preview</summary><p>Correct transcription only; preserve the original dialogue. Timings stay locked to the source.</p><div className="caption-corrections">{sourceCaptions.map((cue, i) => <div key={i}>{cue.words?.length ? cue.words.map((word, j) => <label key={j}><small>{stamp(word.start)}</small><input aria-label={`Caption at ${word.start}`} maxLength={100} disabled={disabled} value={corrected(word.start, word.end, word.word.trim())} onChange={e => correct(word.start, word.end, e.target.value)} /></label>) : <label><small>{stamp(cue.start)} (segment timing)</small><input aria-label={`Caption at ${cue.start}`} maxLength={100} disabled={disabled} value={corrected(cue.start, cue.end, cue.text)} onChange={e => correct(cue.start, cue.end, e.target.value)} /></label>}</div>)}</div></details>
      </div>}
    </>}
  </section>;
}
