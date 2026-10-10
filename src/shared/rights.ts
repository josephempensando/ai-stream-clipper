import { z } from 'zod';

export const platforms = ['tiktok', 'facebook-reels', 'youtube-shorts'] as const;
export const rightsUses = ['private-analysis', 'excerpt', 'adaptation', 'commentary', 'commercial', 'publish'] as const;
export const rightsCategories = ['own-work', 'licensed', 'public-domain', 'creative-commons', 'unknown', 'prohibited', 'claimed-exception'] as const;
export const ccLicenses = ['CC BY 4.0', 'CC BY-SA 4.0', 'CC BY-NC 4.0', 'CC BY-NC-SA 4.0', 'CC BY-ND 4.0', 'CC BY-NC-ND 4.0'] as const;
export type DestinationPlatform = typeof platforms[number];
export type RightsUse = typeof rightsUses[number];
const webReference = z.string().trim().max(4096).refine(value => {
  if (!value) return true;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}, 'Use an HTTP or HTTPS reference URL.');
export const sourceRightsSchema = z.object({
  originalCreator: z.string().trim().max(300).default(''),
  sourceUrl: webReference.default(''),
  category: z.enum(rightsCategories).default('unknown'),
  permissionEvidence: z.string().trim().max(6000).default(''),
  licenseUrl: webReference.default(''),
  ccLicense: z.union([z.enum(ccLicenses), z.literal('')]).default(''),
  conditions: z.string().trim().max(6000).default(''),
  allowedPlatforms: z.array(z.enum(platforms)).max(3).refine(values => new Set(values).size === values.length).default([]),
  allowedUses: z.array(z.enum(rightsUses)).max(6).refine(values => new Set(values).size === values.length).default([]),
  expiresAt: z.iso.datetime({ offset: true }).nullable().default(null),
}).strict();
export type SourceRights = z.infer<typeof sourceRightsSchema>;

export function unknownRights(): SourceRights { return sourceRightsSchema.parse({}); }
export function normalizeRights(value: unknown): SourceRights {
  const result = sourceRightsSchema.safeParse(value);
  return result.success ? result.data : unknownRights();
}

export function ccConditions(license: SourceRights['ccLicense']): string[] {
  if (!license) return [];
  const conditions = ['Credit the creator and supplied notices, link the source and license, and indicate changes.'];
  if (license.includes('NC')) conditions.push('NonCommercial: commercial use is not granted by this license.');
  if (license.includes('ND')) conditions.push('NoDerivatives: sharing adaptations is not granted; review whether the planned edit is an adaptation.');
  if (license.includes('SA')) conditions.push('ShareAlike: shared adaptations must use the same or a compatible license.');
  conditions.push('Do not add legal or technical restrictions that prevent others exercising the licensed rights. Other rights may still need permission.');
  return conditions;
}
export interface RightsAssessment {
  status: 'unestablished' | 'recorded' | 'restricted' | 'expired' | 'prohibited' | 'review-required';
  automatedPublishingAllowed: false;
  issues: string[];
  conditions: string[];
}
export function assessRights(value: unknown, options: { platform?: DestinationPlatform; uses?: RightsUse[]; now?: Date } = {}): RightsAssessment {
  const rights = normalizeRights(value); const issues: string[] = [];
  const conditions = rights.category === 'creative-commons' ? ccConditions(rights.ccLicense) : [];
  if (rights.conditions) conditions.push(rights.conditions);
  if (!rights.originalCreator) issues.push('Original creator is missing.');
  if (!rights.sourceUrl && rights.category !== 'own-work') issues.push('Source URL is missing.');
  if (!rights.permissionEvidence) issues.push('Permission or license evidence is missing; possession of an MP4 is not evidence.');
  if (!rights.allowedPlatforms.length) issues.push('No publishing platforms are recorded.');
  if (!rights.allowedUses.includes('publish')) issues.push('Publishing use is not recorded.');
  if (rights.category === 'licensed' && !rights.licenseUrl && !rights.conditions) issues.push('Record the license terms or a license reference.');
  if (rights.category === 'creative-commons' && (!rights.ccLicense || !rights.licenseUrl)) issues.push('Select the actual Creative Commons license and record its source license reference.');
  const missing = issues.length > 0;
  if (options.platform && !rights.allowedPlatforms.includes(options.platform)) issues.push(`The destination platform ${options.platform} is not allowed by the recorded scope.`);
  for (const use of options.uses || []) if (!rights.allowedUses.includes(use)) issues.push(`The ${use} use is not allowed by the recorded scope.`);
  if (rights.category === 'creative-commons') {
    const uses = options.uses || rights.allowedUses;
    if (rights.ccLicense.includes('NC') && uses.includes('commercial')) issues.push('Commercial use conflicts with the NonCommercial license condition.');
    if (rights.ccLicense.includes('ND') && uses.some(use => use === 'adaptation' || use === 'commentary')) issues.push('The planned edited use requires human review under NoDerivatives; permission to share adaptations is not established.');
  }
  const expired = rights.expiresAt !== null && Date.parse(rights.expiresAt) <= (options.now || new Date()).getTime();
  if (expired) issues.push('Recorded permission has expired.');
  if (rights.category === 'unknown') issues.push('Publishing rights are unknown. Private analysis remains available.');
  if (rights.category === 'prohibited') issues.push('The recorded rights prohibit publishing.');
  if (rights.category === 'claimed-exception') issues.push('A claimed legal exception requires human review; the app does not decide whether an exception applies.');
  const status: RightsAssessment['status'] = rights.category === 'prohibited' ? 'prohibited' : expired ? 'expired'
    : rights.category === 'claimed-exception' ? 'review-required' : rights.category === 'unknown' || missing ? 'unestablished'
      : issues.length ? 'restricted' : 'recorded';
  return { status, issues, conditions, automatedPublishingAllowed: false };
}
