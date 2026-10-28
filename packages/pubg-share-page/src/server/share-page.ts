import type { NormalizedMatch, ReviewShareRecord } from '@rine-kit/pubg-domain';
import { mapDisplayName, type ResearchSquad } from '@rine-kit/pubg-intelligence';

export const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/gu,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );

export function shareTitle(record: ReviewShareRecord): { title: string; description: string } {
  try {
    if (record.kind === 'query') {
      const query = JSON.parse(record.presentationJson) as { title?: string; displayText?: string };
      const lines = (query.displayText ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      return {
        title: `${query.title ?? 'PUBG 战绩'} · ${record.matchIds.length} 场`,
        description: lines[1] ?? 'PUBG 战绩查询',
      };
    }
    const review = JSON.parse(record.presentationJson) as {
      startAt?: string;
      matchCount?: number;
      headline?: string;
      timezone?: string;
    };
    const date = review.startAt
      ? new Intl.DateTimeFormat('zh-CN', {
          timeZone: review.timezone ?? 'Asia/Shanghai',
          month: 'numeric',
          day: 'numeric',
        }).format(new Date(review.startAt))
      : '';
    const title =
      record.kind === 'match'
        ? `单局复盘 · ${date}`
        : `时段复盘 · ${date} · ${review.matchCount ?? record.matchIds.length} 场排位`;
    return { title, description: review.headline ?? 'PUBG 小队复盘' };
  } catch {
    return { title: 'PUBG 小队复盘', description: 'PUBG 小队复盘' };
  }
}

export function messagePage(title: string, body: string, refresh?: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">${refresh ? `<meta http-equiv="refresh" content="${escapeHtml(refresh)}">` : ''}<title>${escapeHtml(title)}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1112;color:#dce6e2;font:15px/1.6 system-ui,sans-serif;padding:24px;box-sizing:border-box}main{max-width:360px;text-align:center}h1{font-size:19px;margin:0 0 8px}p{color:#93a39e;margin:0}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></main></body></html>`;
}

export interface AliasableStory {
  fights: Array<{ start: number; enemies: Array<{ team: string }> }>;
  downs: Array<{ t: number; attackerTeam: string | null }>;
  enemies: Array<{ id: string; team: string; route: Array<[number, number, number]> }>;
}

/** Opposing teams become 敌方 A, B, … in the order the squad met them; opposing account ids become opaque. */
export function aliasEnemies<T extends AliasableStory>(story: T): T {
  const order: string[] = [];
  const see = (team: string | null) => {
    if (team !== null && !order.includes(team)) order.push(team);
  };
  for (const fight of [...story.fights].sort((left, right) => left.start - right.start))
    for (const enemy of fight.enemies) see(enemy.team);
  for (const down of [...story.downs].sort((left, right) => left.t - right.t))
    see(down.attackerTeam);
  for (const enemy of [...story.enemies].sort(
    (left, right) => (left.route[0]?.[0] ?? 0) - (right.route[0]?.[0] ?? 0),
  ))
    see(enemy.team);
  const label = (team: string) => {
    const index = order.indexOf(team);
    return `敌方 ${String.fromCharCode(65 + (index % 26))}${index >= 26 ? Math.floor(index / 26) + 1 : ''}`;
  };
  return {
    ...story,
    fights: story.fights.map((fight) => ({
      ...fight,
      enemies: fight.enemies.map((enemy) => ({ ...enemy, team: label(enemy.team) })),
    })),
    downs: story.downs.map((down) => ({
      ...down,
      attackerTeam: down.attackerTeam === null ? null : label(down.attackerTeam),
    })),
    enemies: story.enemies.map((enemy, index) => ({
      ...enemy,
      id: `enemy-${index + 1}`,
      team: label(enemy.team),
    })),
  };
}

function teamLine(match: NormalizedMatch, squad: ResearchSquad) {
  const members = match.players.filter((player) => squad.memberIds.includes(player.accountId));
  return {
    placement: members[0]?.rank ?? null,
    kills: members.reduce((sum, player) => sum + player.kills, 0),
    knocks: members.reduce((sum, player) => sum + player.dbnos, 0),
    damage: Math.round(members.reduce((sum, player) => sum + player.damage, 0)),
  };
}

/** What GET /api/share/view returns; the /s/ page also carries it inline so the page needs no extra round trip. */
export function shareViewPayload(
  share: ReviewShareRecord,
  squad: ResearchSquad,
  matches: ReadonlyMap<string, NormalizedMatch>,
): Record<string, unknown> {
  return {
    kind: share.kind,
    expiresAt: share.expiresAt,
    review: JSON.parse(share.presentationJson) as unknown,
    matches: share.matchIds.map((matchId) => {
      const match = matches.get(matchId);
      if (!match) return { matchId, available: false };
      return {
        matchId,
        available: true,
        createdAt: match.createdAt,
        mapName: match.mapName,
        mapLabel: mapDisplayName(match.mapName || '未知地图'),
        durationSeconds: match.duration,
        ...teamLine(match, squad),
      };
    }),
  };
}

/** JSON inside a <script>: nothing in it may close the tag or start a comment. */
export const inlineJson = (value: unknown) =>
  JSON.stringify(value)
    .replace(/</gu, '\\u003c')
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029');

/**
 * Shown before the page script has arrived (it is replaced as soon as the app mounts). The steps are the real ones:
 * the server has checked the link and read the review by the time this HTML exists; the browser still has to fetch
 * the page program and build the cards.
 */
export function bootSteps(matchCount: number): string {
  const step = (state: string, label: string) =>
    `<li class="${state}"><i></i><span>${escapeHtml(label)}</span></li>`;
  return `<style>.share-boot{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;background:#0b1112;color:#dce6e2;font:14px/1.5 system-ui,sans-serif;padding:24px}.share-boot .boot-mark{width:43px;height:43px;border:1px solid #41584c;border-radius:12px;display:grid;place-items:center;color:#b8f277;font:800 23px system-ui;animation:sb-pulse 1.5s ease-in-out infinite}.load-steps{list-style:none;margin:0;padding:0;display:grid;gap:9px;min-width:240px}.load-steps li{display:flex;align-items:center;gap:10px;color:#6f817c}.load-steps li i{width:16px;height:16px;flex:none;border-radius:50%;border:2px solid #2c3e3a;box-sizing:border-box}.load-steps li.done{color:#b9c8c2}.load-steps li.done i{border-color:#b8f277;background:#b8f277;box-shadow:inset 0 0 0 3px #0b1112}.load-steps li.active{color:#eef5f1}.load-steps li.active i{border-color:#2c3e3a;border-top-color:#b8f277;animation:sb-spin .8s linear infinite}@keyframes sb-spin{to{transform:rotate(360deg)}}@keyframes sb-pulse{50%{opacity:.4}}</style><div class="share-boot"><div class="boot-mark">P</div><ol class="load-steps">${[
    step('done', '校验分享链接'),
    step('done', `读取复盘与 ${matchCount} 场对局`),
    step('active', '下载页面程序'),
    step('', '生成队员卡片与对局列表'),
  ].join('')}</ol></div>`;
}
