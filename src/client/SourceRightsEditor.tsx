import { ShieldCheck } from 'lucide-react';
import { assessRights, ccLicenses, platforms, rightsUses } from '../shared/rights.js';
import type { SourceRights } from '../shared/rights.js';

const categories: Record<SourceRights['category'], string> = { 'own-work': 'My own original work', licensed: 'Licensed or written permission', 'public-domain': 'Public domain (record evidence)', 'creative-commons': 'Creative Commons', unknown: 'Unknown publishing rights', prohibited: 'Publishing prohibited', 'claimed-exception': 'Claimed legal exception — human review' };
const platformNames = { tiktok: 'TikTok', 'facebook-reels': 'Facebook Reels', 'youtube-shorts': 'YouTube Shorts' };
const useNames = { 'private-analysis': 'Private analysis', excerpt: 'Use excerpts', adaptation: 'Edit / adapt', commentary: 'Commentary', commercial: 'Commercial use', publish: 'Publish' };

export default function SourceRightsEditor({ rights, onChange, onSave, disabled, dirty }: { rights: SourceRights; onChange: (rights: SourceRights) => void; onSave?: () => void; disabled: boolean; dirty: boolean }) {
  const assessment = assessRights(rights);
  const set = <K extends keyof SourceRights>(key: K, value: SourceRights[K]) => onChange({ ...rights, [key]: value });
  return <section className="panel rights-panel" aria-label="Source rights">
    <div className="panel-title"><ShieldCheck size={18} /><h2>Source rights</h2><span className="status-pill">{assessment.status.replaceAll('-', ' ')}</span></div>
    <div className="rights-body">
      <p>Record the source and what permission covers. An MP4 upload is not proof of publishing rights. Private analysis remains available while publishing rights are unresolved.</p>
      <fieldset disabled={disabled} className="rights-fields">
        <label>Original creator<input maxLength={300} value={rights.originalCreator} onChange={e => set('originalCreator', e.target.value)} placeholder="Creator or rights holder" /></label>
        <label>Original source URL<input type="url" maxLength={4096} value={rights.sourceUrl} onChange={e => set('sourceUrl', e.target.value)} placeholder="Original source, if available" /></label>
        <label>License category<select aria-label="License category" value={rights.category} onChange={e => set('category', e.target.value as SourceRights['category'])}>{Object.entries(categories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        {rights.category === 'creative-commons' && <label>Creative Commons license<select aria-label="Creative Commons license" value={rights.ccLicense} onChange={e => set('ccLicense', e.target.value as SourceRights['ccLicense'])}><option value="">Select the actual license</option>{ccLicenses.map(license => <option key={license}>{license}</option>)}</select></label>}
        <label>License reference URL<input type="url" value={rights.licenseUrl} maxLength={4096} onChange={e => set('licenseUrl', e.target.value)} placeholder="Where the license or grant is documented" /></label>
        <label>{rights.category === 'claimed-exception' ? 'Claimed exception and review evidence' : 'Permission / license evidence'}<textarea rows={3} maxLength={6000} value={rights.permissionEvidence} onChange={e => set('permissionEvidence', e.target.value)} placeholder="Grant reference, license notice, ownership or public-domain basis; keep supporting documents locally" /></label>
        <label>Additional license conditions<textarea rows={2} maxLength={6000} value={rights.conditions} onChange={e => set('conditions', e.target.value)} placeholder="Credit wording, jurisdiction, restrictions or grant terms" /></label>
        <fieldset className="rights-choices"><legend>Allowed platforms in the recorded grant</legend>{platforms.map(platform => <label className="checkbox" key={platform}><input type="checkbox" checked={rights.allowedPlatforms.includes(platform)} onChange={e => set('allowedPlatforms', e.target.checked ? [...rights.allowedPlatforms, platform] : rights.allowedPlatforms.filter(p => p !== platform))} />{platformNames[platform]}</label>)}</fieldset>
        <fieldset className="rights-choices"><legend>Allowed uses in the recorded grant</legend>{rightsUses.map(use => <label className="checkbox" key={use}><input type="checkbox" checked={rights.allowedUses.includes(use)} onChange={e => set('allowedUses', e.target.checked ? [...rights.allowedUses, use] : rights.allowedUses.filter(u => u !== use))} />{useNames[use]}</label>)}</fieldset>
        <label>Permission expires (UTC)<input type="datetime-local" value={rights.expiresAt ? new Date(rights.expiresAt).toISOString().slice(0, 16) : ''} onChange={e => set('expiresAt', e.target.value ? new Date(`${e.target.value}:00Z`).toISOString() : null)} /></label>
        <small>Leave blank if no expiration is recorded. A blank date does not mean unlimited permission.</small>
      </fieldset>
      {!!assessment.conditions.length && <div className="rights-conditions"><strong>License conditions to review</strong><ul>{assessment.conditions.map(condition => <li key={condition}>{condition}</li>)}</ul>{rights.category === 'creative-commons' && <a href="https://creativecommons.org/cc-licenses/" target="_blank" rel="noreferrer">Read Creative Commons license conditions ↗</a>}</div>}
      <details className="rights-issues"><summary>{assessment.issues.length ? `${assessment.issues.length} publishing rights issue(s)` : 'Rights information recorded — human review still required'}</summary>{assessment.issues.map(issue => <p key={issue}>{issue}</p>)}</details>
      <p className="rights-note">This is a record of your declarations, not copyright certification or legal clearance. No automated publishing is enabled.</p>
      {onSave && <button type="button" className="button secondary full" disabled={disabled || !dirty} onClick={onSave}>{dirty ? 'Save rights record' : 'Rights record saved'}</button>}
    </div>
  </section>;
}
