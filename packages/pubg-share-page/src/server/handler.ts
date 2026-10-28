import type { NormalizedMatch, ReviewShareRecord } from '@rine-kit/pubg-domain';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { StoryContext } from './context.js';
import {
  CLIENT_DIST,
  clientAsset,
  clientBuilt,
  renderSharePage,
  toResearchSquad,
} from './render.js';
import { aliasEnemies, escapeHtml, shareViewPayload } from './share-page.js';
import { computeMatchStory } from './story.js';

/** A share visitor's cookie: only the share routes read it, and it never opens anything else. */
export const SHARE_COOKIE = 'pubg_share';
const TOKEN = /^[A-Za-z0-9_-]{22}$/u;
const MAP_IMAGE = /^[A-Za-z0-9]+_Main$/u;
const MATCH_ID = /^[A-Za-z0-9_.-]{1,64}$/u;
const CONTENT_TTL_MS = 60_000;

/** The room's team as the page shows it, and the stored matches the share lists (those that are stored). */
export interface ShareContent {
  squad: { id: string; label: string; members: { id: string; name: string }[] };
  matches: NormalizedMatch[];
}

/**
 * Where a host's data comes from: RINE reads Postgres, Lab can read SQLite. The handler never touches a database,
 * and never sees a token — only its SHA-256.
 */
export interface ShareStore {
  /** The share with this token hash, or null. Revoked and expired shares may be returned; the handler rejects them. */
  findShare(tokenHash: string): Promise<ReviewShareRecord | null>;
  /**
   * The team and the matches a share lists. Must be limited to `share.matchIds` and to the share's own team — this
   * is what a link is allowed to read. Null when the team is gone.
   */
  loadContent(share: ReviewShareRecord): Promise<ShareContent | null>;
}

/** What the handler needs of an HTTP request, so any server (Fastify, Express, a bare http server) can host it. */
export interface ShareRequest {
  method?: string;
  /** The URL path, as received (percent-encoded), without the query string. */
  path: string;
  /** The Cookie header. */
  cookie?: string | undefined;
  /** True when the visitor reached the host over https (decides the cookie's Secure flag). */
  https?: boolean;
  /** Who is asking, for `allow`. */
  remote?: string;
}

export interface ShareResponse {
  status: number;
  headers: Record<string, string>;
  body: string | Buffer;
}

export interface ShareHandlerOptions {
  store: ShareStore;
  /** Telemetry analysis for the story view; null = the page shows the stored numbers only (story → 503). */
  story?: StoryContext | null;
  /** Directory with `<Map>_Main.jpg|png`; unset = no map artwork. */
  mapDirectory?: string | undefined;
  /** Called before each request that carries a token; false answers 429. */
  allow?: (remote: string) => boolean;
  now?: () => number;
}

export type ShareHandler = (request: ShareRequest) => Promise<ShareResponse | null>;

/** What the tactical page may load: itself, inline script/style it carries, images, same-origin fetches. */
const PAGE_CSP =
  "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const TEXT_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json',
};

/** The chat text of a report as HTML: escaped first, then **bold** and line breaks (the only markup a report uses). */
export function reportHtml(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*([^*\n]+)\*\*/gu, '<strong>$1</strong>')
    .replace(/\n/gu, '<br>');
}

const textPage = (title: string, body: string) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:dark light;--bg:#14121a;--fg:#ece9f1;--muted:#a9a3b5;--card:#1d1a26;--line:#2d2938}
@media (prefers-color-scheme:light){:root{--bg:#f6f4f8;--fg:#1b1822;--muted:#5d5769;--card:#fff;--line:#e0dce6}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 system-ui,"PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:720px;margin:0 auto;padding:24px 16px 48px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px 20px;overflow-wrap:anywhere}
.meta{color:var(--muted);font-size:13px;margin-top:14px}
h1{font-size:18px;margin:0 0 14px}
</style></head><body><main>${body}</main></body></html>`;

function cookieToken(header: string | undefined): string | null {
  for (const part of (header ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === SHARE_COOKIE) return value.join('=');
  }
  return null;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function segments(path: string): string[] | null {
  try {
    return path.split('/').map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
}

/**
 * The read-only share surface of a PUBG report link, as one function from request to response.
 *
 * Access rules, enforced here for every route and not left to the host:
 * - the only way in is a token: `/s/<token>` opens the page and sets a cookie holding it, and every data route
 *   (`/api/share/*`, `/api/maps/*`, `/share`) reads that cookie — there is no overview and no listing without one;
 * - a token is 22 characters of url-safe base64, only its SHA-256 reaches the store;
 * - a link opens exactly the matches it lists; a revoked, expired, unknown or malformed token all answer alike;
 * - the opposing teams are anonymised before a story leaves the server.
 * `/assets/*` (the page's own program, nothing about any player) is the one public path.
 * Returns null for a path that is not a share route, so the host can fall through to its own 404.
 */
export function createShareHandler(options: ShareHandlerOptions): ShareHandler {
  const { store, story = null, mapDirectory, allow, now = Date.now } = options;
  const loaded = new Map<
    string,
    { at: number; value: Promise<{ share: ReviewShareRecord; content: ShareContent | null }> }
  >();

  const open = async (token: string | null): Promise<{ token: string; share: ReviewShareRecord } | null> => {
    if (!token || !TOKEN.test(token)) return null;
    const share = await store.findShare(sha256(token));
    if (!share || share.revokedAt !== null || Date.parse(share.expiresAt) <= now()) return null;
    return { token, share };
  };

  /** The share's team and stored matches; kept for a minute so a story click costs no query. */
  const contentOf = (found: { token: string; share: ReviewShareRecord }) => {
    const key = sha256(found.token);
    const hit = loaded.get(key);
    if (hit && now() - hit.at < CONTENT_TTL_MS) return hit.value.then((entry) => entry.content);
    const value = store.loadContent(found.share).then((content) => ({ share: found.share, content }));
    loaded.set(key, { at: now(), value });
    value.catch(() => loaded.delete(key));
    if (loaded.size > 200)
      for (const [k, v] of loaded) if (now() - v.at > CONTENT_TTL_MS) loaded.delete(k);
    return value.then((entry) => entry.content);
  };

  const respond = (
    status: number,
    csp: string,
    body: string | Buffer,
    type: string,
    extra: Record<string, string> = {},
  ): ShareResponse => ({
    status,
    headers: {
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
      'content-security-policy': csp,
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'content-type': type,
      ...extra,
    },
    body,
  });
  const json = (status: number, value: unknown) =>
    respond(status, TEXT_CSP, JSON.stringify(value), 'application/json; charset=utf-8');
  const tooMany = (): ShareResponse => ({
    status: 429,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    body: 'too many requests',
  });
  const gone = () =>
    respond(
      404,
      TEXT_CSP,
      textPage('分享', '<div class="card"><h1>这个链接已失效</h1>链接过期了，或者发它的人撤回了。</div>'),
      'text/html; charset=utf-8',
    );

  const sendPage = async (request: ShareRequest, found: { token: string; share: ReviewShareRecord }) => {
    const text = (() => {
      try {
        return JSON.parse(found.share.presentationJson) as {
          title?: unknown;
          displayText?: unknown;
          matchCount?: unknown;
        };
      } catch {
        return null;
      }
    })();
    const content = clientBuilt() ? await contentOf(found) : null;
    if (content && text) {
      const squad = toResearchSquad(content.squad, content.matches.length);
      const html = renderSharePage(
        readFileSync(join(CLIENT_DIST, 'index.html'), 'utf8'),
        found.share,
        squad,
        new Map(content.matches.map((match) => [match.matchId, match])),
      );
      const seconds = Math.max(0, Math.floor((Date.parse(found.share.expiresAt) - now()) / 1000));
      const secure = request.https ? '; Secure' : '';
      return respond(200, PAGE_CSP, html, 'text/html; charset=utf-8', {
        'set-cookie': `${SHARE_COOKIE}=${found.token}; Path=/; Max-Age=${seconds}; HttpOnly; SameSite=Strict${secure}`,
      });
    }
    // The page is not built, or the team is gone: the report text alone, still only for a valid link.
    const body = typeof text?.displayText === 'string' ? text.displayText : '';
    if (!body) return gone();
    const title = typeof text?.title === 'string' && text.title ? text.title : 'PUBG 战绩';
    const matches = typeof text?.matchCount === 'number' ? `共 ${text.matchCount} 场对局 · ` : '';
    return respond(
      200,
      TEXT_CSP,
      textPage(
        title,
        `<div class="card">${reportHtml(body)}</div><p class="meta">${matches}链接 7 天内有效，不需要登录</p>`,
      ),
      'text/html; charset=utf-8',
    );
  };

  return async (request) => {
    if ((request.method ?? 'GET') !== 'GET') return null;
    const parts = segments(request.path);
    if (!parts) return null;
    const [, first, second, third, fourth, ...rest] = parts;
    const remote = request.remote ?? '';

    if (first === 'assets' && second !== undefined) {
      const file = clientAsset(request.path);
      if (!file) return { status: 404, headers: { 'content-type': 'application/json' }, body: '{"error":"not_found"}' };
      const type = CONTENT_TYPES[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream';
      // Vite names every built asset by its content hash, so a browser may keep it for good.
      return {
        status: 200,
        headers: {
          'cache-control': 'public, max-age=31536000, immutable',
          'x-content-type-options': 'nosniff',
          'content-type': type,
        },
        body: readFileSync(file),
      };
    }

    const isPage = (first === 's' && second !== undefined && third === undefined) || (first === 'share' && second === undefined);
    const isView = first === 'api' && second === 'share' && third === 'view' && fourth === undefined;
    const isStory = first === 'api' && second === 'share' && third === 'matches' && fourth !== undefined && rest.length === 1 && rest[0] === 'story';
    const isMap = first === 'api' && second === 'maps' && third !== undefined && fourth === undefined;
    if (!isPage && !isView && !isStory && !isMap) return null;

    if (allow && !allow(remote)) return tooMany();

    if (isPage) {
      // /s/<token> brings the token in the address; /share is the same page by cookie after the page has dropped it.
      const found = await open(first === 's' ? (second ?? null) : cookieToken(request.cookie));
      return found ? sendPage(request, found) : gone();
    }

    const found = await open(cookieToken(request.cookie));
    if (!found) return json(401, { error: 'share_required' });

    if (isView) {
      const content = await contentOf(found);
      if (!content) return json(404, { error: 'not_found' });
      const squad = toResearchSquad(content.squad, content.matches.length);
      return json(
        200,
        shareViewPayload(found.share, squad, new Map(content.matches.map((match) => [match.matchId, match]))),
      );
    }

    if (isStory) {
      const matchId = fourth ?? '';
      // A link opens only the matches it lists.
      if (!MATCH_ID.test(matchId) || !found.share.matchIds.includes(matchId))
        return json(404, { error: 'not_in_share' });
      const content = await contentOf(found);
      const match = content?.matches.find((candidate) => candidate.matchId === matchId);
      if (!content || !match) return json(404, { error: 'not_in_share' });
      if (!story) return json(503, { error: 'story_unavailable' });
      const squad = toResearchSquad(content.squad, content.matches.length);
      const result = await computeMatchStory(story, squad, match);
      return json(200, {
        ...result,
        story: result.story
          ? aliasEnemies(result.story as unknown as Parameters<typeof aliasEnemies>[0])
          : null,
      });
    }

    // map artwork
    const name = third ?? '';
    if (!mapDirectory || !MAP_IMAGE.test(name)) return json(404, { error: 'not_found' });
    for (const [extension, type] of [
      ['jpg', 'image/jpeg'],
      ['png', 'image/png'],
    ] as const) {
      const file = join(mapDirectory, `${name}.${extension}`);
      if (existsSync(file) && statSync(file).isFile()) {
        return {
          status: 200,
          headers: {
            'cache-control': 'private, max-age=86400',
            'x-content-type-options': 'nosniff',
            'content-type': type,
          },
          body: readFileSync(file),
        };
      }
    }
    return json(404, { error: 'map_image_missing' });
  };
}
