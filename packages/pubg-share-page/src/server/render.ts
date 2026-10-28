import type { NormalizedMatch, ReviewShareRecord } from '@rine-kit/pubg-domain';
import type { ResearchSquad } from '@rine-kit/pubg-intelligence';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootSteps, escapeHtml, inlineJson, shareTitle, shareViewPayload } from './share-page.js';

/**
 * The built page. From a checkout it sits at `<package>/dist/client` (two levels above `src/server`); from the
 * published package this file is `dist/server/render.js` and the page is its sibling `dist/client`.
 */
export const CLIENT_DIST = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const published = resolve(here, '../client');
  return existsSync(join(published, 'index.html')) ? published : resolve(here, '../../dist/client');
})();

export const clientBuilt = (): boolean => existsSync(join(CLIENT_DIST, 'index.html'));

/** A file of the built page for a request path under /assets/, or null (never outside the build's assets directory). */
export function clientAsset(pathname: string): string | null {
  if (!pathname.startsWith('/assets/')) return null;
  const target = resolve(CLIENT_DIST, `.${pathname}`);
  if (!target.startsWith(`${join(CLIENT_DIST, 'assets')}/`)) return null;
  return existsSync(target) && statSync(target).isFile() ? target : null;
}

/**
 * The page shell with the share's view carried inline (so the page needs no extra round trip) and an og title.
 * The caller has already checked the link; nothing here reads a database.
 */
export function renderSharePage(
  shell: string,
  share: ReviewShareRecord,
  squad: ResearchSquad,
  matches: ReadonlyMap<string, NormalizedMatch>,
): string {
  const { title, description } = shareTitle(share);
  const head = `<meta name="robots" content="noindex,nofollow"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:type" content="website">`;
  const view = `<script>window.__SHARE_VIEW__=${inlineJson(shareViewPayload(share, squad, matches))}</script>`;
  return shell
    .replace(/<title>[^<]*<\/title>/u, `<title>${escapeHtml(title)}</title>${head}${view}`)
    .replace('<div id="root"></div>', `<div id="root">${bootSteps(share.matchIds.length)}</div>`);
}

/** The research squad the page works with: the room's team, whose members are the only players in the stored matches. */
export function toResearchSquad(
  team: { id: string; label: string; members: { id: string; name: string }[] },
  matchCount: number,
): ResearchSquad {
  return {
    id: team.id,
    label: team.label,
    memberIds: team.members.map((member) => member.id),
    members: team.members,
    matchCount,
  };
}
