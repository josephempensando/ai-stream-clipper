import type { CaptionStyle } from '../shared/retention.js';
export default function CaptionSettings({ value, onChange, disabled }: { value: CaptionStyle; onChange: (value: CaptionStyle) => void; disabled: boolean }) {
  const set = <K extends keyof CaptionStyle>(key: K, next: CaptionStyle[K]) => onChange({ ...value, [key]: next });
  return <fieldset className="caption-settings retention-controls" disabled={disabled}>
    <label className="checkbox"><input type="checkbox" checked={value.enabled} onChange={e => set('enabled', e.target.checked)} />Captions</label>
    <label>Animation<select value={value.animation} onChange={e => set('animation', e.target.value as CaptionStyle['animation'])}><option value="karaoke">Karaoke · actual word timings</option><option value="fade">Subtle fade</option><option value="none">Plain</option></select></label>
    <label>Font<select value={value.font} onChange={e => set('font', e.target.value as CaptionStyle['font'])}>{['Arial', 'Verdana', 'Trebuchet MS'].map(f => <option key={f}>{f}</option>)}</select></label>
    <label>Font size<input type="number" min="32" max="80" value={value.size} onChange={e => set('size', Number(e.target.value))} /></label>
    <label>Text color<input type="color" value={value.color} onChange={e => set('color', e.target.value)} /></label>
    <label>Highlight color<input type="color" value={value.highlight} onChange={e => set('highlight', e.target.value)} /></label>
    <label>Outline<input type="number" min="0" max="6" value={value.outline} onChange={e => set('outline', Number(e.target.value))} /></label>
    <label>Position<select value={value.position} onChange={e => set('position', e.target.value as CaptionStyle['position'])}><option value="lower">Lower safe area</option><option value="middle">Middle</option><option value="upper">Upper safe area</option></select></label>
    <label>Words per group<input type="number" min="2" max="8" value={value.wordsPerGroup} onChange={e => set('wordsPerGroup', Number(e.target.value))} /></label>
  </fieldset>;
}
