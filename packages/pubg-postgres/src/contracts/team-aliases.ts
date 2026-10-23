export interface NormalizedTeamAlias {
  key: string;
  displayAlias: string;
}

export function normalizeTeamAlias(value: unknown): NormalizedTeamAlias {
  if (typeof value !== 'string') throw new Error('team_alias_invalid');
  const displayAlias = value.normalize('NFKC').trim();
  if (!displayAlias || displayAlias.length > 100 || /[\u0000-\u001f\u007f]/u.test(displayAlias)) throw new Error('team_alias_invalid');
  return { key: displayAlias.toLocaleLowerCase('en-US'), displayAlias };
}

export function normalizeTeamMemberLookup(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
}
