import { useEffect, useState } from 'react';
import { LoadSteps } from './load-steps.js';
import { MatchStoryView, type MatchStoryData } from './match-story.js';

// Mirrors GET /api/share/view: the review exactly as delivered to the group, and the matches it covers.
interface ShareReview {
  startAt: string;
  endAt: string;
  timezone: string;
  matchCount: number;
  maps: Array<{ mapName: string; count: number }>;
  headline: string;
  placements: Array<number | null>;
  summary: {
    avgPlacement: number | null;
    baselineAvgPlacement: number | null;
    wins: number;
    top10: number;
    teamKnocks: number;
    avgTeamDamage: number;
  };
  findings: Array<{
    metric: string;
    tone: 'good' | 'bad' | 'neutral';
    confidence: 'clear' | 'observation';
    text: string;
  }>;
  members: Array<{
    name: string;
    matches: number;
    kills: number;
    knocks: number;
    damagePerMatch: number;
    earlyOuts: number;
    revives: number;
    tags: string[];
  }>;
  suggestion?: string;
  coverage: { telemetry: number; total: number };
}

interface ShareMatch {
  matchId: string;
  available: boolean;
  createdAt?: string | null;
  mapLabel?: string;
  durationSeconds?: number;
  placement?: number | null;
  kills?: number;
  knocks?: number;
  damage?: number;
}

/** A shared query answer (今日战绩 and the like): the answer text exactly as it was sent. */
interface ShareQueryPlayer {
  label: string;
  position?: number | null;
  values: Record<string, string | number | null>;
  titles: string[];
}

interface ShareQuery {
  title: string;
  displayText: string;
  dataUpdatedAt: string | null;
  timezone: string;
  players?: ShareQueryPlayer[];
  teamTotals?: string | null;
}

type ShareView =
  | { kind: 'session' | 'match'; expiresAt: string; review: ShareReview; matches: ShareMatch[] }
  | { kind: 'query'; expiresAt: string; review: ShareQuery; matches: ShareMatch[] };

const MAP_NAMES: Record<string, string> = {
  Baltic_Main: '艾伦格',
  Erangel_Main: '艾伦格',
  Desert_Main: '米拉玛',
  Tiger_Main: '泰戈',
  Neon_Main: '荣都',
  Kiki_Main: '帝斯顿',
  Savage_Main: '萨诺',
  DihorOtok_Main: '维寒迪',
  Chimera_Main: '帕拉莫',
  Summerland_Main: '卡拉金',
  Heaven_Main: '哈文',
};

function clock(value: string, timezone: string, withDate = true): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
    ...(withDate ? { month: 'numeric', day: 'numeric' } : {}),
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(value));
}

function rankText(rank: number | null | undefined): string {
  if (rank === null || rank === undefined) return '#?';
  return rank === 1 ? '🏆' : `#${rank}`;
}

const TAGS: Record<string, string> = {
  top_damage: '输出最高',
  early_outs: '早出局多',
  medic: '救援最多',
};

function metricNumber(key: string, raw: string | number | null | undefined): string {
  if (raw === null || raw === undefined) return '—';
  if (typeof raw === 'string') return raw;
  if (!Number.isFinite(raw)) return '—';
  if (Number.isInteger(raw)) return String(raw);
  if (key === 'kd' || key === 'avg_kills' || key === 'top10_rate' || key === 'avg_rank')
    return (Math.round(raw * 100) / 100).toFixed(2);
  return (Math.round(raw * 10) / 10).toFixed(1);
}

const MEDALS = ['🥇', '🥈', '🥉'] as const;

function metricValue(player: ShareQueryPlayer, key: string): number {
  const raw = player.values[key];
  const amount = typeof raw === 'number' ? raw : Number(raw);
  return raw === null || raw === undefined || !Number.isFinite(amount) ? -1 : amount;
}

/** Same order as the chat 战报: K/D first, then kills, then damage. */
function rankPlayers(players: ShareQueryPlayer[]): ShareQueryPlayer[] {
  return [...players].sort(
    (a, b) =>
      metricValue(b, 'kd') - metricValue(a, 'kd') ||
      metricValue(b, 'kills') - metricValue(a, 'kills') ||
      metricValue(b, 'damage') - metricValue(a, 'damage'),
  );
}

function QueryPlayerCard({ player, place }: { player: ShareQueryPlayer; place: number }) {
  const values = player.values;
  const kd = metricNumber('kd', values.kd ?? null);
  const avgDamage = metricNumber('avg_damage', values.avg_damage ?? null);
  const top10Rate =
    values.top10_rate === null || values.top10_rate === undefined
      ? null
      : `${Math.round(Number(values.top10_rate) * 1000) / 10}%`;
  const wins = Number(values.wins ?? 0);
  return (
    <div className="share-query-player">
      <div className="share-query-player-head">
        <b>
          {MEDALS[place] ?? '🎖️'} {player.label}
        </b>
        {player.titles?.map((title) => (
          <em key={title}>{title}</em>
        ))}
      </div>
      <div className="share-query-gauges">
        <div>
          <b>{kd}</b>
          <span>KD</span>
        </div>
        <div>
          <b>{avgDamage}</b>
          <span>场均伤害</span>
        </div>
        <div>
          <b>{top10Rate ?? metricNumber('top10', values.top10 ?? null)}</b>
          <span>{top10Rate ? '前十率' : '前十'}</span>
        </div>
        <div>
          <b>{wins > 0 ? wins : metricNumber('matches', values.matches ?? null)}</b>
          <span>{wins > 0 ? '吃鸡' : '场次'}</span>
        </div>
      </div>
      <div className="share-query-player-meta">
        {metricNumber('matches', values.matches ?? null)} 场 ·{' '}
        {metricNumber('kills', values.kills ?? null)} 杀 ·{' '}
        {metricNumber('assists', values.assists ?? null)} 助攻 ·{' '}
        {metricNumber('damage', values.damage ?? null)} 伤害 ·{' '}
        {metricNumber('dbnos', values.dbnos ?? null)} 击倒 ·{' '}
        {metricNumber('revives', values.revives ?? null)} 救援
        {values.longest_kill !== null && values.longest_kill !== undefined
          ? ` · 最远 ${metricNumber('longest_kill', values.longest_kill)}m`
          : ''}
      </div>
    </div>
  );
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const MODES: Record<string, string> = {
  squad: '四排',
  'squad-fpp': '四排',
  duo: '双排',
  'duo-fpp': '双排',
  solo: '单排',
  'solo-fpp': '单排',
};

/** "10月19日 星期一" from the answer's 数据范围 line; a range spanning several days reads "10月18日–10月19日". */
function rangeLabel(displayText: string): string | null {
  const match = displayText.match(
    /数据范围：(\d{4})-(\d{2})-(\d{2}) \d{2}:\d{2} 至 (\d{4})-(\d{2})-(\d{2})/u,
  );
  if (!match) return null;
  const [, y1, m1, d1, y2, m2, d2] = match.map(Number) as number[];
  const start = Date.UTC(y1!, m1! - 1, d1!);
  const days = Math.round((Date.UTC(y2!, m2! - 1, d2!) - start) / 86_400_000);
  if (days <= 1) return `${m1}月${d1}日 星期${WEEKDAYS[new Date(start).getUTCDay()]}`;
  const last = new Date(Date.UTC(y2!, m2! - 1, d2! - 1));
  return `${m1}月${d1}日–${last.getUTCMonth() + 1}月${last.getUTCDate()}日`;
}

/** A match-list answer: the matches themselves are listed below, so the card only names the period and the count. */
function matchListSummary(displayText: string): { headline: string; summary: string } | null {
  const rows = displayText
    .split('\n')
    .filter((line) => line.startsWith('- ') && line.includes('｜'));
  if (!rows.length) return null;
  const modes = new Set(rows.map((line) => MODES[line.split('｜')[2]?.trim() ?? ''] ?? '对局'));
  const mode = modes.size === 1 ? [...modes][0]! : '对局';
  const period = rangeLabel(displayText);
  return {
    headline: `${period ? `${period} ` : ''}${mode === '对局' ? '对局' : `${mode}对局`}`,
    summary: `共 ${rows.length} 场${mode === '对局' ? '' : mode}，每一局的过程在下面。`,
  };
}

function QueryCard({ query }: { query: ShareQuery }) {
  const players = rankPlayers(query.players ?? []);
  const lines = query.displayText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const list = players.length ? null : matchListSummary(query.displayText);
  const generic = /^(?:🏆\s*)?(?:指定时间|PUBG 战绩)$/u.test(lines[0] ?? '');
  const period = rangeLabel(query.displayText);
  const headline =
    list?.headline ?? (generic && period ? `${period} 战绩` : (lines[0] ?? query.title));
  const summary = list?.summary ?? lines[1] ?? '';
  return (
    <section className="share-card">
      <div className="share-kicker">
        战绩查询
        {query.dataUpdatedAt ? ` · 数据更新于 ${clock(query.dataUpdatedAt, query.timezone)}` : ''}
      </div>
      <h1 className="share-headline">{headline}</h1>
      {summary && <p className="share-plain">{summary}</p>}
      {players.length > 0 ? (
        <div className="share-query-players">
          {players.map((player, place) => (
            <QueryPlayerCard
              key={`${player.label}-${player.position ?? ''}`}
              player={player}
              place={place}
            />
          ))}
        </div>
      ) : list ? null : (
        <pre className="share-query-text">{query.displayText}</pre>
      )}
      {query.teamTotals && <p className="share-query-totals">{query.teamTotals}</p>}
    </section>
  );
}

function ReviewCard({ view }: { view: Extract<ShareView, { kind: 'session' | 'match' }> }) {
  const { review } = view;
  const single = view.kind === 'match';
  const sameDay =
    clock(review.startAt, review.timezone).split(' ')[0] ===
    clock(review.endAt, review.timezone).split(' ')[0];
  const window = `${clock(review.startAt, review.timezone)}–${clock(review.endAt, review.timezone, !sameDay)}`;
  const maps = review.maps
    .map(
      (map) =>
        `${MAP_NAMES[map.mapName] ?? map.mapName.replace(/_Main$/u, '')}${map.count > 1 ? `×${map.count}` : ''}`,
    )
    .join(' · ');
  return (
    <section className="share-card">
      <div className="share-kicker">
        {single ? '单局复盘' : '时段复盘'} · {window}
      </div>
      <div className="share-maps">
        {review.matchCount} 场排位 · {maps}
      </div>
      <h1 className="share-headline">{review.headline}</h1>
      {!single && (
        <div className="share-strip">
          {review.placements.map((rank, index) => (
            <span key={index} className={rank !== null && rank <= 10 ? 'top' : ''}>
              {rankText(rank)}
            </span>
          ))}
        </div>
      )}
      <div className="share-stats">
        <div>
          <b>{review.summary.avgPlacement?.toFixed(1) ?? '?'}</b>
          <span>
            场均名次
            {review.summary.baselineAvgPlacement !== null
              ? ` · 平时 ${review.summary.baselineAvgPlacement.toFixed(1)}`
              : ''}
          </span>
        </div>
        <div>
          <b>{review.summary.teamKnocks}</b>
          <span>击倒</span>
        </div>
        <div>
          <b>{review.summary.avgTeamDamage}</b>
          <span>场均团队伤害</span>
        </div>
        <div>
          <b>
            {review.summary.wins} / {review.summary.top10}
          </b>
          <span>吃鸡 / 前十</span>
        </div>
      </div>
      {review.findings.length > 0 ? (
        <ul className="share-findings">
          {review.findings.map((finding) => (
            <li key={finding.metric} className={finding.tone}>
              <i />
              {finding.text}
              {finding.confidence === 'clear' && <em>有把握</em>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="share-plain">各项都在平时的正常波动范围内。</p>
      )}
      {!single && review.members.length > 0 && (
        <div className="share-members">
          {review.members.map((member) => (
            <div key={member.name}>
              <b>{member.name}</b>
              <span>
                击倒 {member.knocks} · 淘汰 {member.kills} · {member.damagePerMatch}/场
                {member.matches !== review.matchCount ? ` · ${member.matches} 场` : ''}
              </span>
              {member.tags.map((tag) => (
                <em key={tag}>{TAGS[tag] ?? tag}</em>
              ))}
            </div>
          ))}
        </div>
      )}
      {review.suggestion && (
        <p className="share-suggestion">
          <b>下次试试</b>
          {review.suggestion}
        </p>
      )}
    </section>
  );
}

/** The read-only page a review link opens: this review, its matches and each match's story, nothing more. */
export function ShareApp() {
  const [view, setView] = useState<ShareView | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [story, setStory] = useState<MatchStoryData | null>(null);
  const [storyLoading, setStoryLoading] = useState(false);

  useEffect(() => {
    // The token only travels once, in the link; keep it out of history and anything copied from the address bar.
    if (window.location.pathname.startsWith('/s/')) window.history.replaceState(null, '', '/share');
    const accept = (data: ShareView) => {
      setView(data);
      const first = data.matches.find((match) => match.available);
      // A wide screen shows the story beside the list, so it opens the first match instead of an empty pane.
      if (first && (data.kind === 'match' || window.matchMedia('(min-width: 1200px)').matches))
        setSelected(first.matchId);
    };
    // The /s/ page carries the view inline; a reload of /share asks for it.
    const inline = (window as { __SHARE_VIEW__?: ShareView }).__SHARE_VIEW__;
    if (inline) {
      accept(inline);
      return;
    }
    void fetch('/api/share/view', { credentials: 'same-origin', cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        accept((await response.json()) as ShareView);
      })
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => {
    if (!selected) return;
    setStoryLoading(true);
    setStory(null);
    void fetch(`/api/share/matches/${encodeURIComponent(selected)}/story`, {
      credentials: 'same-origin',
      cache: 'no-store',
    })
      .then(async (response) =>
        response.ok ? setStory((await response.json()) as MatchStoryData) : setStory(null),
      )
      .finally(() => setStoryLoading(false));
  }, [selected]);

  if (failed) {
    return (
      <div className="share-shell">
        <div className="share-empty">
          <h1>链接无效或已过期</h1>
          <p>分享链接 7 天内有效。需要的话请让队友重新发一份。</p>
        </div>
      </div>
    );
  }
  if (!view) {
    return (
      <div className="share-boot">
        <div className="boot-mark">P</div>
        <LoadSteps
          steps={[
            { label: '校验分享链接', state: 'done' },
            { label: '下载页面程序', state: 'done' },
            { label: '读取复盘与对局数据', state: 'active' },
            { label: '生成队员卡片与对局列表', state: 'pending' },
          ]}
        />
      </div>
    );
  }
  const selectedMatch = view.matches.find((match) => match.matchId === selected);
  return (
    <div className="share-shell">
      <header className="share-top">
        <div className="brand-mark">P</div>
        <div>
          <strong>PUBG 小队复盘</strong>
          <small>只读分享</small>
        </div>
      </header>
      <div className="share-body">
        <div className="share-main">
          {view.kind === 'query' ? <QueryCard query={view.review} /> : <ReviewCard view={view} />}
          {view.kind !== 'match' && (
            <section className="share-list">
              <h2>
                这几场 <small>点开看每一局的过程</small>
              </h2>
              {view.matches.map((match, index) => (
                <button
                  type="button"
                  key={match.matchId}
                  disabled={!match.available}
                  className={`share-match ${selected === match.matchId ? 'active' : ''}`}
                  onClick={() => setSelected(selected === match.matchId ? null : match.matchId)}
                >
                  <span className="share-match-index">{index + 1}</span>
                  <span className="share-match-main">
                    <b>{match.mapLabel ?? '数据同步中'}</b>
                    <small>
                      {match.createdAt ? clock(match.createdAt, view.review.timezone, false) : ''}
                    </small>
                  </span>
                  <span className="share-match-rank">{rankText(match.placement)}</span>
                  <span className="share-match-meta">
                    {match.available ? `击倒 ${match.knocks} · 伤害 ${match.damage}` : ''}
                  </span>
                </button>
              ))}
            </section>
          )}
        </div>
        <div className="share-side">
          {!selectedMatch && view.kind !== 'match' && (
            <section className="share-story-empty">点开左边任意一局，这里显示整局过程。</section>
          )}
          {selectedMatch && (
            <section className="share-story">
              <MatchStoryView
                anonymized
                data={story}
                loading={storyLoading}
                placement={selectedMatch.placement ?? null}
                kills={selectedMatch.kills ?? 0}
                damage={selectedMatch.damage ?? 0}
              />
            </section>
          )}
        </div>
      </div>
      <footer className="share-foot">
        只读分享 · 仅包含{view.kind === 'query' ? '这次查询' : '本次复盘'}的 {view.matches.length}{' '}
        场 · {clock(view.expiresAt, view.review.timezone ?? 'Asia/Shanghai')} 前有效 ·
        敌方队伍已匿名
      </footer>
    </div>
  );
}
