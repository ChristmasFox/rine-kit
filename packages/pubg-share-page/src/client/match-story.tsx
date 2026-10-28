import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { LoadSteps } from './load-steps.js';

// ---------------------------------------------------------------------------------------------------------------
// Types mirroring GET /api/matches/:id/story

type LifeState = 'alive' | 'down' | 'dead';
interface LifeSegment {
  from: number;
  to: number;
  state: LifeState;
}
interface RoutePoint {
  t: number;
  x: number;
  y: number;
  vehicle: boolean;
  down: boolean;
}
interface CirclePoint {
  t: number;
  phase: number | null;
  aliveTeams: number | null;
  alivePlayers: number | null;
  zone: { x: number; y: number; r: number } | null;
  warn: { x: number; y: number; r: number } | null;
}
interface StoryEvent {
  t: number;
  kind: 'knock' | 'kill' | 'downed' | 'death' | 'revive';
  member: string;
  other: string | null;
  weapon: string | null;
  meters: number | null;
  byPlayer: boolean;
  afterKnock: boolean;
}
interface StoryEnemy {
  id: string;
  team: string;
  route: Array<[number, number, number]>;
  diedAt: number | null;
}
interface FightEnemy {
  team: string;
  size: number;
  downed: number;
  damageToUs: number;
  damageFromUs: number;
  weapons: string[];
}
interface StoryFight {
  index: number;
  start: number;
  end: number;
  phase: number | null;
  aliveTeams: number | null;
  enemyTeams: number;
  outcome: 'win' | 'lose' | 'draw' | 'skirmish';
  initiator: 'us' | 'them' | 'unknown';
  enemyDowns: number;
  ourDowns: number;
  ourKills: number;
  revives: number;
  damageDealt: number;
  damageTaken: number;
  members: Array<{ member: string; damage: number; knocks: number; downed: number }>;
  enemies: FightEnemy[];
}
type DownCause =
  | 'ambush_far'
  | 'ambush_close'
  | 'crossfire'
  | 'isolated'
  | 'lost_duel'
  | 'bluezone'
  | 'environment';
interface StoryDown {
  t: number;
  member: string;
  cause: DownCause;
  attackerTeam: string | null;
  weapon: string | null;
  meters: number | null;
  returnDamage: number;
  takenDamage: number;
  teamsHitting: number;
  nearestTeammate: number | null;
  alone: boolean | null;
  teamsNearby: number | null;
  phase: number | null;
  outcome: 'revived' | 'died' | 'unknown';
  afterSeconds: number | null;
}
interface TurningPoint {
  kind: 'first_loss' | 'collapse' | 'costly' | 'decisive' | 'final_fight';
  t: number;
  fight: number | null;
  member: string | null;
  count: number;
}
interface RotationEpoch {
  phase: number | null;
  start: number;
  end: number;
  radius: number;
  outsideAtStart: number;
  enteredAfter: number | null;
  shrinkAfter: number | null;
  margin: number | null;
  blueSeconds: number;
  blueDamage: number;
  distance: number;
  vehicleShare: number | null;
}
interface MatchRotation {
  epochs: RotationEpoch[];
  blueSeconds: number;
  blueDamage: number;
  distance: number;
  vehicleShare: number | null;
  landingToFight: number | null;
  lateEntries: number;
  circlesChecked: number;
}
interface StoryPlayer {
  member: string;
  landing: { t: number; x: number; y: number } | null;
  lifeline: LifeSegment[];
  route: RoutePoint[];
  damagePerMinute: number[];
  diedAt: number | null;
}
interface Story {
  mapName: string | null;
  durationSeconds: number;
  startTeams: number | null;
  startPlayers: number | null;
  events: StoryEvent[];
  fights: StoryFight[];
  circle: CirclePoint[];
  phaseStarts: Array<{ phase: number; t: number }>;
  players: StoryPlayer[];
  enemies: StoryEnemy[];
  downs: StoryDown[];
  turningPoints: TurningPoint[];
  rotation: MatchRotation;
  squadOutAt: number | null;
  teamsAtEnd: number | null;
}
interface StoryRow {
  accountId: string;
  name: string;
  damage: number;
  kills: number;
  knocks: number;
  assists: number;
  revives: number;
  survivalSeconds: number;
  rank: number | null;
  hitRate: number | null;
  damagePerMinute: number | null;
  timesDowned: number | null;
  heals: number | null;
  throwables: number | null;
  rides: number | null;
  footKm: number | null;
  longestStreak: number | null;
}
export interface MatchStoryData {
  matchId: string;
  available: boolean;
  reason: string | null;
  mapName: string | null;
  mapLabel: string;
  mapSizeKm: number | null;
  gameMode: string;
  durationSeconds: number;
  createdAt: string | null;
  names: Record<string, string>;
  downCauses: Array<{ key: DownCause; label: string; advice: string }>;
  players: StoryRow[];
  story: Story | null;
}

const TONES = ['p0', 'p1', 'p2', 'p3'] as const;
const OUTCOME = {
  win: { text: '胜', tone: 'win' },
  lose: { text: '负', tone: 'lose' },
  draw: { text: '均势', tone: 'draw' },
  skirmish: { text: '试探', tone: 'skirmish' },
} as const;

function clock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function toneOf(data: MatchStoryData, member: string): string {
  const index = data.players.findIndex((row) => row.accountId === member);
  return TONES[(index < 0 ? 0 : index) % 4]!;
}

function Section({
  title,
  hint,
  children,
  className = '',
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`av-panel ms-section ${className}`}>
      <header>
        <h3>{title}</h3>
        {hint && <span>{hint}</span>}
      </header>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Plain-language narration

function fightSentence(fight: StoryFight, name: (id: string) => string): string {
  const opener =
    fight.initiator === 'us'
      ? '我们先开火'
      : fight.initiator === 'them'
        ? '对方先开火'
        : '双方接触';
  const against = fight.enemyTeams > 1 ? `${fight.enemyTeams} 支队伍` : '1 支队伍';
  const parts: string[] = [];
  if (fight.enemyDowns > 0)
    parts.push(
      `打倒 ${fight.enemyDowns} 人${fight.ourKills > 0 ? `（其中补掉 ${fight.ourKills} 人）` : ''}`,
    );
  if (fight.ourDowns > 0) parts.push(`${fight.ourDowns} 名队员被击倒`);
  if (!parts.length) parts.push('没有人倒地');
  if (fight.revives > 0) parts.push(`救起 ${fight.revives} 次`);
  const lead = fight.members[0];
  const star =
    lead && lead.damage >= 100 ? `；${name(lead.member)} 输出最多（${lead.damage}）` : '';
  return `${opener}，与${against}交战 ${Math.max(1, fight.end - fight.start)} 秒：${parts.join('，')}${star}。`;
}

function turningPointText(
  point: TurningPoint,
  data: MatchStoryData,
): { tone: 'good' | 'bad' | 'info'; text: string } {
  const name = (id: string | null) => (id ? (data.names[id] ?? '队员') : '队员');
  const fight = point.fight !== null ? `第 ${point.fight} 场交战` : '';
  switch (point.kind) {
    case 'first_loss':
      return {
        tone: 'bad',
        text: `${clock(point.t)} ${name(point.member)} 被淘汰${fight ? `（${fight}）` : ''}——小队从此少一个人，是比赛的第一个无法挽回的损失。`,
      };
    case 'collapse':
      return {
        tone: 'bad',
        text: `从 ${clock(point.t)} 起连续 ${point.count} 场交战落了下风，之后再没能翻过来，直到全队被淘汰。`,
      };
    case 'final_fight':
      return {
        tone: 'bad',
        text: `${clock(point.t)} 的${fight}是最后一战：被打倒的人比打倒的多 ${Math.max(0, point.count)} 个，全队就此出局。`,
      };
    case 'costly':
      return {
        tone: 'bad',
        text: `代价最大的一场是${fight}（${clock(point.t)}）：被打倒的人比打倒的多 ${point.count} 个。`,
      };
    case 'decisive':
      return {
        tone: 'good',
        text: `决定性的一场是${fight}（${clock(point.t)}）：打倒的人比被打倒的多 ${point.count} 个，把局面扳了回来。`,
      };
  }
}

interface Highlight {
  tone: 'good' | 'bad' | 'info';
  text: string;
}

function buildHighlights(data: MatchStoryData, story: Story): Highlight[] {
  const out: Highlight[] = [];
  const name = (id: string) => data.names[id] ?? '队员';
  const rank =
    data.players
      .map((row) => row.rank)
      .find((value): value is number => value !== null && value > 0) ?? null;
  const wins = story.fights.filter((fight) => fight.outcome === 'win').length;
  const losses = story.fights.filter((fight) => fight.outcome === 'lose').length;
  if (story.fights.length)
    out.push({
      tone: wins > losses ? 'good' : losses > wins ? 'bad' : 'info',
      text: `共 ${story.fights.length} 波交战：${wins} 胜 ${losses} 负，累计打倒 ${story.fights.reduce((sum, fight) => sum + fight.enemyDowns, 0)} 人，被击倒 ${story.fights.reduce((sum, fight) => sum + fight.ourDowns, 0)} 人次。`,
    });
  const downs = story.events.filter((event) => event.kind === 'downed');
  const first = downs[0];
  if (first)
    out.push({
      tone: 'info',
      text: `${clock(first.t)} ${name(first.member)} 第一个被击倒${first.byPlayer ? '' : '（环境）'}，此时已进行到第 ${[...story.phaseStarts].reverse().find((item) => item.t <= first.t)?.phase ?? 1} 圈。`,
    });
  else out.push({ tone: 'good', text: '全程没有队员被击倒。' });
  const revives = story.events.filter((event) => event.kind === 'revive').length;
  if (downs.length)
    out.push({
      tone: revives > 0 ? 'good' : 'bad',
      text: `被击倒 ${downs.length} 次，救起 ${revives} 次${revives === 0 ? '——没有一次救援成功' : ''}。`,
    });
  const bestFight = [...story.fights].sort(
    (left, right) => right.enemyDowns - left.enemyDowns || right.damageDealt - left.damageDealt,
  )[0];
  if (bestFight && bestFight.enemyDowns >= 2)
    out.push({
      tone: 'good',
      text: `最漂亮的一波是第 ${bestFight.index} 场（${clock(bestFight.start)}）：打倒 ${bestFight.enemyDowns} 人，${bestFight.ourDowns === 0 ? '自己无人倒地' : `自己倒 ${bestFight.ourDowns} 人`}。`,
    });
  const knocks = story.events
    .filter((event) => event.kind === 'knock' && event.meters !== null)
    .sort((left, right) => right.meters! - left.meters!)[0];
  if (knocks && knocks.meters! >= 150)
    out.push({
      tone: 'good',
      text: `最远的击倒：${name(knocks.member)} 用 ${knocks.weapon ?? '武器'} 在 ${knocks.meters} 米外（${clock(knocks.t)}）。`,
    });
  if (story.downs.length >= 3) {
    const counts = new Map<DownCause, number>();
    for (const down of story.downs) counts.set(down.cause, (counts.get(down.cause) ?? 0) + 1);
    const parts = [...counts.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(
        ([cause, count]) =>
          `${data.downCauses.find((item) => item.key === cause)?.label ?? cause} ${count}`,
      );
    out.push({ tone: 'info', text: `${story.downs.length} 次倒地的原因：${parts.join('、')}。` });
  }
  for (const point of story.turningPoints) out.push(turningPointText(point, data));
  if (story.squadOutAt !== null) {
    const end = story.circle.filter((point) => point.t <= story.squadOutAt!).at(-1);
    out.push({
      tone: 'bad',
      text: `全队在 ${clock(story.squadOutAt)} 被淘汰${end?.phase ? `，第 ${end.phase} 圈` : ''}${story.teamsAtEnd !== null ? `，场上还剩 ${story.teamsAtEnd} 队` : ''}${rank !== null ? `，最终第 ${rank} 名` : ''}。`,
    });
  } else if (rank !== null) {
    out.push({
      tone: rank === 1 ? 'good' : 'info',
      text: rank === 1 ? '坚持到了最后，吃鸡！' : `坚持到了对局末段，最终第 ${rank} 名。`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Charts

const TL_W = 1000;
const TL_LEFT = 92;
const TL_RIGHT = 14;
const LANE_H = 26;
const TL_TOP = 78;

function Timeline({
  data,
  story,
  time,
  onTime,
  selectedFight,
  onFight,
}: {
  data: MatchStoryData;
  story: Story;
  time: number;
  onTime: (t: number) => void;
  selectedFight: number | null;
  onFight: (index: number) => void;
}) {
  const duration = Math.max(60, story.durationSeconds);
  const x = (t: number) =>
    TL_LEFT + (Math.min(duration, Math.max(0, t)) / duration) * (TL_W - TL_LEFT - TL_RIGHT);
  const lanes = story.players;
  const height = TL_TOP + lanes.length * LANE_H + 34;
  const startTeams =
    story.startTeams ?? Math.max(...story.circle.map((point) => point.aliveTeams ?? 0), 1);
  const teamY = (value: number) => 62 - (value / startTeams) * 44;
  const teamPoints = story.circle.filter((point) => point.aliveTeams !== null);
  const teamPath = teamPoints
    .map(
      (point, index) =>
        `${index === 0 ? 'M' : 'L'}${x(point.t).toFixed(1)},${teamY(point.aliveTeams!).toFixed(1)}`,
    )
    .join(' ');
  const bands = story.phaseStarts.map((item, index) => ({
    phase: item.phase,
    from: item.t,
    to: story.phaseStarts[index + 1]?.t ?? duration,
  }));
  const ticks = Array.from({ length: Math.floor(duration / 300) + 1 }, (_, index) => index * 300);
  const locate = (event: MouseEvent | React.MouseEvent<SVGSVGElement>, element: SVGSVGElement) => {
    const box = element.getBoundingClientRect();
    const ratio = ((event.clientX - box.left) / box.width) * TL_W;
    onTime(
      Math.min(duration, Math.max(0, ((ratio - TL_LEFT) / (TL_W - TL_LEFT - TL_RIGHT)) * duration)),
    );
  };
  return (
    <svg
      viewBox={`0 0 ${TL_W} ${height}`}
      className="ms-timeline"
      role="img"
      aria-label="单局时间线"
      onClick={(event) => locate(event, event.currentTarget)}
    >
      {bands.map((band, index) => (
        <g key={band.phase}>
          <rect
            x={x(band.from)}
            y={20}
            width={Math.max(0, x(band.to) - x(band.from))}
            height={height - 54}
            className={`band ${index % 2 ? 'odd' : ''}`}
          />
          <text x={x(band.from) + 4} y={14} className="band-label">
            圈 {band.phase}
          </text>
        </g>
      ))}
      {[0.25, 0.5, 0.75, 1].map((fraction) => (
        <line
          key={fraction}
          x1={TL_LEFT}
          x2={TL_W - TL_RIGHT}
          y1={teamY(startTeams * fraction)}
          y2={teamY(startTeams * fraction)}
          className="grid"
        />
      ))}
      <text x={TL_LEFT - 8} y={teamY(startTeams) + 3} className="axis-label" textAnchor="end">
        {startTeams} 队
      </text>
      <text x={TL_LEFT - 8} y={64} className="axis-label" textAnchor="end">
        0
      </text>
      {teamPath && (
        <path
          d={`${teamPath} L${x(teamPoints.at(-1)!.t).toFixed(1)},62 L${x(teamPoints[0]!.t).toFixed(1)},62 Z`}
          className="teams-area"
        />
      )}
      {teamPath && <path d={teamPath} className="teams-line" />}
      <text x={TL_LEFT - 8} y={36} className="axis-label strong" textAnchor="end">
        场上队伍
      </text>
      {story.fights.map((fight) => (
        <g
          key={fight.index}
          className={`fight ${OUTCOME[fight.outcome].tone} ${selectedFight === fight.index ? 'sel' : ''}`}
          onClick={(event) => {
            event.stopPropagation();
            onFight(fight.index);
          }}
        >
          <rect
            x={x(fight.start) - 1}
            y={TL_TOP - 6}
            width={Math.max(5, x(fight.end) - x(fight.start) + 2)}
            height={lanes.length * LANE_H + 8}
            rx={3}
          >
            <title>{`第 ${fight.index} 场 · ${clock(fight.start)}–${clock(fight.end)} · ${OUTCOME[fight.outcome].text}`}</title>
          </rect>
          <text
            x={x(fight.start) + Math.max(2.5, (x(fight.end) - x(fight.start)) / 2)}
            y={TL_TOP - 10}
            textAnchor="middle"
            className="fight-no"
          >
            {fight.index}
          </text>
        </g>
      ))}
      {lanes.map((player, lane) => {
        const y = TL_TOP + lane * LANE_H;
        const tone = toneOf(data, player.member);
        return (
          <g key={player.member} className={`lane ${tone}`}>
            <text x={TL_LEFT - 8} y={y + LANE_H / 2 + 3} textAnchor="end" className="lane-name">
              {(data.names[player.member] ?? '').replace(/^SG_LabmemNo/u, 'No.').slice(0, 10)}
            </text>
            <line
              x1={TL_LEFT}
              x2={TL_W - TL_RIGHT}
              y1={y + LANE_H / 2}
              y2={y + LANE_H / 2}
              className="lane-base"
            />
            {player.lifeline.map((segment, index) => (
              <rect
                key={index}
                x={x(segment.from)}
                y={y + 6}
                width={Math.max(1, x(segment.to) - x(segment.from))}
                height={LANE_H - 12}
                rx={3}
                className={`life ${segment.state}`}
              >
                <title>{`${data.names[player.member]} · ${segment.state === 'alive' ? '存活' : segment.state === 'down' ? '倒地' : '淘汰'} ${clock(segment.from)}–${clock(segment.to)}`}</title>
              </rect>
            ))}
            {player.diedAt !== null && (
              <g transform={`translate(${x(player.diedAt)},${y + LANE_H / 2})`}>
                <circle r={5} className="death" />
                <path d="M-2.5,-2.5L2.5,2.5M2.5,-2.5L-2.5,2.5" className="death-x" />
              </g>
            )}
            {story.events
              .filter((event) => event.member === player.member)
              .map((event, index) => {
                const cx = x(event.t);
                const cy = y + LANE_H / 2;
                const label = `${clock(event.t)} ${data.names[event.member]} ${event.kind === 'knock' ? '击倒' : event.kind === 'kill' ? '击杀' : event.kind === 'downed' ? '被击倒' : event.kind === 'death' ? '被淘汰' : `救起 ${data.names[event.other ?? ''] ?? '队友'}`}${event.weapon ? ` · ${event.weapon}` : ''}${event.meters !== null ? ` · ${event.meters}m` : ''}`;
                if (event.kind === 'knock')
                  return (
                    <path key={index} d={`M${cx},${cy - 11}l4.5,8h-9z`} className="mk knock">
                      <title>{label}</title>
                    </path>
                  );
                if (event.kind === 'kill')
                  return (
                    <path
                      key={index}
                      d={`M${cx - 3.5},${cy - 11}l7,7m0,-7l-7,7`}
                      className="mk kill"
                    >
                      <title>{label}</title>
                    </path>
                  );
                if (event.kind === 'revive')
                  return (
                    <path key={index} d={`M${cx},${cy + 4}v8m-4,-4h8`} className="mk revive">
                      <title>{label}</title>
                    </path>
                  );
                if (event.kind === 'downed')
                  return (
                    <path key={index} d={`M${cx},${cy + 12}l4.5,-8h-9z`} className="mk downed">
                      <title>{label}</title>
                    </path>
                  );
                return null;
              })}
          </g>
        );
      })}
      {ticks.map((tick) => (
        <g key={tick}>
          <line x1={x(tick)} x2={x(tick)} y1={height - 30} y2={height - 26} className="tick" />
          <text x={x(tick)} y={height - 14} textAnchor="middle" className="axis-label">
            {clock(tick)}
          </text>
        </g>
      ))}
      {story.turningPoints.map((point) => (
        <g
          key={`${point.kind}${point.t}`}
          className={`turn ${point.kind === 'decisive' ? 'good' : 'bad'}`}
        >
          <line x1={x(point.t)} x2={x(point.t)} y1={20} y2={height - 28} />
          <path d={`M${x(point.t)},16 l6,-9 h-12 z`}>
            <title>{turningPointText(point, data).text}</title>
          </path>
        </g>
      ))}
      <line x1={x(time)} x2={x(time)} y1={20} y2={height - 28} className="cursor" />
    </svg>
  );
}

const MAP_VIEW = 1000;

function interpolate(
  player: StoryPlayer,
  t: number,
): { x: number; y: number; vehicle: boolean; down: boolean; gone: boolean } | null {
  const route = player.route;
  if (!route.length) return null;
  if (player.diedAt !== null && t > player.diedAt + 20) {
    const last = [...route].reverse().find((point) => point.t <= player.diedAt!) ?? route.at(-1)!;
    return { x: last.x, y: last.y, vehicle: false, down: false, gone: true };
  }
  if (t <= route[0]!.t)
    return {
      x: player.landing?.x ?? route[0]!.x,
      y: player.landing?.y ?? route[0]!.y,
      vehicle: false,
      down: false,
      gone: t < (player.landing?.t ?? route[0]!.t),
    };
  for (let index = 1; index < route.length; index += 1) {
    const next = route[index]!;
    if (t <= next.t) {
      const prev = route[index - 1]!;
      const f = next.t === prev.t ? 1 : (t - prev.t) / (next.t - prev.t);
      return {
        x: prev.x + (next.x - prev.x) * f,
        y: prev.y + (next.y - prev.y) * f,
        vehicle: next.vehicle,
        down: next.down,
        gone: false,
      };
    }
  }
  const last = route.at(-1)!;
  return { x: last.x, y: last.y, vehicle: last.vehicle, down: last.down, gone: false };
}

function enemyAt(enemy: StoryEnemy, t: number): { x: number; y: number } | null {
  const route = enemy.route;
  if (t < route[0]![0]) return null;
  if (enemy.diedAt !== null && t > enemy.diedAt) return null;
  for (let index = 1; index < route.length; index += 1) {
    const next = route[index]!;
    if (t <= next[0]) {
      const prev = route[index - 1]!;
      const f = next[0] === prev[0] ? 1 : (t - prev[0]) / (next[0] - prev[0]);
      return { x: prev[1] + (next[1] - prev[1]) * f, y: prev[2] + (next[2] - prev[2]) * f };
    }
  }
  const last = route.at(-1)!;
  return t - last[0] > 45 ? null : { x: last[1], y: last[2] };
}

function RouteMap({
  data,
  story,
  time,
  showEnemies,
  focusTeams,
  zoom,
  showImage,
}: {
  data: MatchStoryData;
  story: Story;
  time: number;
  showEnemies: boolean;
  focusTeams: ReadonlySet<string>;
  zoom: boolean;
  showImage: boolean;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(() => new Set());
  const markLoaded = (href: string) =>
    setLoaded((current) => (current.has(href) ? current : new Set([...current, href])));
  // The overview is a 1536 px copy (about 0.5 MB instead of 3.5 MB); zooming in adds the full-size artwork.
  const overview = `/api/maps/${data.mapName}?w=1536`;
  const full = `/api/maps/${data.mapName}`;
  const sizeMeters = (data.mapSizeKm ?? 8) * 1000;
  // Zoom to where the squad actually moved instead of drawing the whole island.
  const baseView = useMemo(() => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const player of story.players) {
      for (const point of player.route) {
        xs.push(point.x);
        ys.push(point.y);
      }
      if (player.landing) {
        xs.push(player.landing.x);
        ys.push(player.landing.y);
      }
    }
    if (!xs.length) return { minX: 0, minY: 0, span: sizeMeters };
    const lowX = Math.min(...xs);
    const highX = Math.max(...xs);
    const lowY = Math.min(...ys);
    const highY = Math.max(...ys);
    const span = Math.min(sizeMeters, Math.max(1500, Math.max(highX - lowX, highY - lowY) * 1.16));
    const minX = Math.max(0, Math.min(sizeMeters - span, (lowX + highX) / 2 - span / 2));
    const minY = Math.max(0, Math.min(sizeMeters - span, (lowY + highY) / 2 - span / 2));
    return { minX, minY, span };
  }, [story, sizeMeters]);
  // Zoomed: follow the squad and the opponents it is fighting right now.
  let view = baseView;
  if (zoom) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const player of story.players) {
      const point = interpolate(player, time);
      if (point && !point.gone) {
        xs.push(point.x);
        ys.push(point.y);
      }
    }
    for (const enemy of story.enemies) {
      if (!focusTeams.has(enemy.team)) continue;
      const point = enemyAt(enemy, time);
      if (point) {
        xs.push(point.x);
        ys.push(point.y);
      }
    }
    if (xs.length) {
      const lowX = Math.min(...xs);
      const highX = Math.max(...xs);
      const lowY = Math.min(...ys);
      const highY = Math.max(...ys);
      const span = Math.min(sizeMeters, Math.max(1400, Math.max(highX - lowX, highY - lowY) * 2.2));
      view = {
        minX: Math.max(0, Math.min(sizeMeters - span, (lowX + highX) / 2 - span / 2)),
        minY: Math.max(0, Math.min(sizeMeters - span, (lowY + highY) / 2 - span / 2)),
        span,
      };
    }
  }
  const px = (value: number) => ((value - view.minX) / view.span) * MAP_VIEW;
  const py = (value: number) => ((value - view.minY) / view.span) * MAP_VIEW;
  const pr = (value: number) => (value / view.span) * MAP_VIEW;
  const step = view.span > 6000 ? 1000 : view.span > 2500 ? 500 : view.span > 1200 ? 250 : 100;
  const zoneNow =
    [...story.circle].reverse().find((point) => point.t <= time && (point.zone || point.warn)) ??
    story.circle.find((point) => point.zone || point.warn);
  // `warn` is the next safe circle (white, fixed for a phase); `zone` is the gas wall (blue, closing on it).
  const finalZone = [...story.circle].reverse().find((point) => point.warn)?.warn ?? null;
  const gridX = Array.from(
    { length: Math.ceil(view.span / step) + 2 },
    (_, index) => Math.floor(view.minX / step) * step + index * step,
  );
  const gridY = Array.from(
    { length: Math.ceil(view.span / step) + 2 },
    (_, index) => Math.floor(view.minY / step) * step + index * step,
  );
  const eventPoint = (event: StoryEvent) => {
    const player = story.players.find((item) => item.member === event.member);
    return player ? interpolate(player, event.t) : null;
  };
  return (
    <svg
      viewBox={`0 0 ${MAP_VIEW} ${MAP_VIEW}`}
      className="ms-map"
      role="img"
      aria-label="行进路线与毒圈"
    >
      <rect width={MAP_VIEW} height={MAP_VIEW} className="map-bg" />
      {showImage && data.mapName && !imageFailed && (
        <image
          href={overview}
          x={px(0)}
          y={py(0)}
          width={pr(sizeMeters)}
          height={pr(sizeMeters)}
          preserveAspectRatio="none"
          className="map-image"
          onLoad={() => markLoaded(overview)}
          onError={() => setImageFailed(true)}
        />
      )}
      {/* Zoomed in, the full-size artwork is laid over the overview once it has arrived. */}
      {showImage && zoom && data.mapName && !imageFailed && (
        <image
          href={full}
          x={px(0)}
          y={py(0)}
          width={pr(sizeMeters)}
          height={pr(sizeMeters)}
          preserveAspectRatio="none"
          className="map-image"
          style={{ opacity: loaded.has(full) ? undefined : 0 }}
          onLoad={() => markLoaded(full)}
        />
      )}
      {showImage && data.mapName && !imageFailed && !loaded.has(zoom ? full : overview) && (
        <text x={MAP_VIEW / 2} y={MAP_VIEW / 2} textAnchor="middle" className="map-loading">
          {zoom && loaded.has(overview) ? '加载高清地图…' : '加载地图底图…'}
        </text>
      )}
      {gridX.map((value) => (
        <line
          key={`x${value}`}
          x1={px(value)}
          x2={px(value)}
          y1={0}
          y2={MAP_VIEW}
          className="map-grid"
        />
      ))}
      {gridY.map((value) => (
        <line
          key={`y${value}`}
          y1={py(value)}
          y2={py(value)}
          x1={0}
          x2={MAP_VIEW}
          className="map-grid"
        />
      ))}
      <text x={10} y={MAP_VIEW - 10} className="map-scale">
        格线间隔 {step >= 1000 ? `${step / 1000} km` : `${step} m`}
      </text>
      {finalZone && (
        <circle
          cx={px(finalZone.x)}
          cy={py(finalZone.y)}
          r={pr(finalZone.r)}
          className="zone-final"
        />
      )}
      {story.phaseStarts.map((item) => {
        const point = story.circle.find((candidate) => candidate.t >= item.t && candidate.warn);
        return point?.warn ? (
          <circle
            key={item.phase}
            cx={px(point.warn.x)}
            cy={py(point.warn.y)}
            r={pr(point.warn.r)}
            className="zone-ghost"
          />
        ) : null;
      })}
      {zoneNow?.zone && (
        <circle
          cx={px(zoneNow.zone.x)}
          cy={py(zoneNow.zone.y)}
          r={pr(zoneNow.zone.r)}
          className="zone-wall"
        />
      )}
      {zoneNow?.warn && (
        <circle
          cx={px(zoneNow.warn.x)}
          cy={py(zoneNow.warn.y)}
          r={pr(zoneNow.warn.r)}
          className="zone-now"
        />
      )}
      {story.players.map((player) => {
        const tone = toneOf(data, player.member);
        const past = player.route.filter(
          (point) => point.t <= time && (!zoom || point.t >= time - 150),
        );
        const rest = zoom ? [] : player.route.filter((point) => point.t > time);
        const toPath = (points: RoutePoint[]) =>
          points
            .map(
              (point, index) =>
                `${index === 0 ? 'M' : 'L'}${px(point.x).toFixed(1)},${py(point.y).toFixed(1)}`,
            )
            .join(' ');
        return (
          <g key={player.member} className={`route ${tone}`}>
            {rest.length > 1 && <path d={toPath(rest)} className="path future" />}
            {past.length > 1 && <path d={toPath(past)} className="path past" />}
            {player.landing && (
              <circle cx={px(player.landing.x)} cy={py(player.landing.y)} r={9} className="landing">
                <title>{`${data.names[player.member]} 落点`}</title>
              </circle>
            )}
          </g>
        );
      })}
      {showEnemies &&
        story.enemies.map((enemy) => {
          const focus = focusTeams.has(enemy.team);
          if (!focus) return null;
          const trail = enemy.route.filter((point) => point[0] <= time && point[0] >= time - 120);
          return trail.length > 1 ? (
            <path
              key={`trail${enemy.id}`}
              d={trail
                .map(
                  (point, index) =>
                    `${index === 0 ? 'M' : 'L'}${px(point[1]).toFixed(1)},${py(point[2]).toFixed(1)}`,
                )
                .join(' ')}
              className="enemy-trail"
            />
          ) : null;
        })}
      {showEnemies &&
        story.enemies.map((enemy) => {
          const point = enemyAt(enemy, time);
          const focus = focusTeams.has(enemy.team);
          if (!point) {
            const diedHere =
              enemy.diedAt !== null && time >= enemy.diedAt && time - enemy.diedAt < 40 && focus;
            const last = enemy.route.filter((item) => item[0] <= (enemy.diedAt ?? 0)).at(-1);
            return diedHere && last ? (
              <path
                key={enemy.id}
                d={`M${px(last[1]) - 8},${py(last[2]) - 8}l16,16m0,-16l-16,16`}
                className="enemy-dead"
              />
            ) : null;
          }
          return (
            <g
              key={enemy.id}
              className={`enemy ${focus ? 'focus' : ''}`}
              transform={`translate(${px(point.x)},${py(point.y)})`}
            >
              <circle r={focus ? 10 : 5.5} />
              {focus && (
                <text y={-15} textAnchor="middle">
                  {teamText(enemy.team)}
                </text>
              )}
              <title>{`对手 ${teamText(enemy.team)}`}</title>
            </g>
          );
        })}
      {story.events
        .filter(
          (event) =>
            event.t <= time &&
            (event.kind === 'knock' ||
              event.kind === 'downed' ||
              event.kind === 'death' ||
              event.kind === 'kill'),
        )
        .map((event, index) => {
          const point = eventPoint(event);
          if (!point) return null;
          const cx = px(point.x);
          const cy = py(point.y);
          const bad = event.kind === 'downed' || event.kind === 'death';
          return (
            <g
              key={index}
              className={`pin ${bad ? 'bad' : 'good'}`}
              transform={`translate(${cx},${cy})`}
            >
              {bad ? <path d="M-9,-9L9,9M9,-9L-9,9" /> : <circle r={6.5} />}
              <title>{`${clock(event.t)} ${data.names[event.member]} ${event.kind === 'knock' ? '击倒' : event.kind === 'kill' ? '击杀' : event.kind === 'downed' ? '被击倒' : '被淘汰'}`}</title>
            </g>
          );
        })}
      {(() => {
        const marks = story.players
          .map((player) => ({ player, point: interpolate(player, time) }))
          .filter(
            (
              item,
            ): item is {
              player: StoryPlayer;
              point: NonNullable<ReturnType<typeof interpolate>>;
            } => item.point !== null,
          );
        const pixels = marks.map((item) => ({ x: px(item.point.x), y: py(item.point.y) }));
        // Labels of members standing close together fan out to four corners instead of piling up.
        const crowded = pixels.some((a, i) =>
          pixels.some((b, j) => j !== i && Math.hypot(a.x - b.x, a.y - b.y) < 46),
        );
        const fan = [
          [-28, -26, 'end'],
          [28, -26, 'start'],
          [-28, 34, 'end'],
          [28, 34, 'start'],
        ] as const;
        return marks.map(({ player, point }, index) => {
          const tone = toneOf(data, player.member);
          const [dx, dy, anchor] = crowded ? fan[index % 4]! : ([0, -22, 'middle'] as const);
          return (
            <g
              key={player.member}
              className={`me ${tone} ${point.down ? 'down' : ''} ${point.gone ? 'gone' : ''}`}
              transform={`translate(${pixels[index]!.x},${pixels[index]!.y})`}
            >
              <circle r={17} className="halo" />
              <circle r={10} className="dot" />
              {crowded && <line x1={0} y1={0} x2={dx * 0.55} y2={dy * 0.55} className="leader" />}
              <text x={dx} y={dy} textAnchor={anchor}>
                {(data.names[player.member] ?? '').replace(/^SG_LabmemNo/u, '').slice(0, 4)}
              </text>
            </g>
          );
        });
      })()}
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Main view

/** Team ids are numbers; a shared review already names opposing teams ("敌方 A"). */
function teamText(team: string): string {
  return team.startsWith('敌方') ? team : `队${team}`;
}

export function MatchStoryView({
  data,
  loading,
  placement,
  kills,
  damage,
  anonymized = false,
}: {
  data: MatchStoryData | null;
  loading: boolean;
  placement: number | null;
  kills: number;
  damage: number;
  anonymized?: boolean;
}) {
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedFight, setSelectedFight] = useState<number | null>(null);
  const [showEnemies, setShowEnemies] = useState(true);
  const [zoom, setZoom] = useState(false);
  const [showImage, setShowImage] = useState(true);
  const timer = useRef<number | null>(null);
  const story = data?.story ?? null;
  const duration = story ? Math.max(60, story.durationSeconds) : 0;

  useEffect(() => {
    setTime(0);
    setPlaying(false);
    setSelectedFight(null);
    // ?fight=N deep-links a fight: the timeline and map open on it.
    const requested = Number(new URLSearchParams(window.location.search).get('fight'));
    const fight = data?.story?.fights.find((item) => item.index === requested);
    if (fight) {
      setSelectedFight(fight.index);
      setZoom(true);
      setTime(fight.start + Math.min(20, (fight.end - fight.start) / 2));
    }
    const rawTime = new URLSearchParams(window.location.search).get('t');
    const requestedTime = rawTime === null ? NaN : Number(rawTime);
    if (Number.isFinite(requestedTime) && requestedTime >= 0 && data?.story) {
      setTime(Math.min(data.story.durationSeconds, requestedTime));
      setZoom(true);
    }
  }, [data?.matchId]);
  useEffect(() => {
    if (!playing || !story) return undefined;
    timer.current = window.setInterval(() => {
      setTime((current) => {
        const next = current + duration / 240;
        if (next >= duration) {
          setPlaying(false);
          return duration;
        }
        return next;
      });
    }, 80);
    return () => {
      if (timer.current !== null) window.clearInterval(timer.current);
    };
  }, [playing, story, duration]);

  const highlights = useMemo(
    () => (data && story ? buildHighlights(data, story) : []),
    [data, story],
  );
  if (loading && !data) {
    return (
      <Section title="这局发生了什么" hint="正在准备这一局">
        <LoadSteps
          compact
          steps={[
            {
              label: anonymized ? '读取本局原始遥测，匿名化敌方队伍' : '读取本局原始遥测',
              state: 'active',
            },
            { label: '生成路线、毒圈与交战时间线', state: 'pending' },
            { label: '加载地图底图', state: 'pending' },
          ]}
        />
      </Section>
    );
  }
  if (!data) return null;
  const name = (id: string) => data.names[id] ?? '队员';
  const jumpToFight = (index: number) => {
    const fight = story?.fights.find((item) => item.index === index);
    if (!fight) return;
    setSelectedFight(index);
    setZoom(true);
    setPlaying(false);
    setTime(fight.start);
  };
  const focusFight =
    story?.fights.find((item) => item.index === selectedFight) ??
    story?.fights.find((item) => time >= item.start - 10 && time <= item.end + 10) ??
    null;
  const focusTeams = new Set(focusFight?.enemies.map((enemy) => enemy.team) ?? []);
  const maxDamage = Math.max(1, ...data.players.map((row) => row.damage));
  const matchLength = Math.max(1, ...data.players.map((row) => row.survivalSeconds), duration);

  return (
    <div className="ms">
      <section className="ms-hero">
        <div className={`rank ${placement === 1 ? 'win' : ''}`}>
          <small>最终名次</small>
          <b>{placement !== null ? `#${placement}` : '—'}</b>
        </div>
        <div className="facts">
          <h2>
            {data.mapLabel} <span>{data.gameMode}</span>
          </h2>
          <p>
            {data.createdAt
              ? new Date(data.createdAt).toLocaleString('zh-CN', { hour12: false })
              : ''}{' '}
            · 时长 {clock(data.durationSeconds)}
            {story?.startTeams ? ` · ${story.startTeams} 队 ${story.startPlayers ?? ''} 人` : ''}
          </p>
        </div>
        <div className="kpis">
          <div>
            <b>{kills}</b>
            <small>击杀</small>
          </div>
          <div>
            <b>{Math.round(damage).toLocaleString('zh-CN')}</b>
            <small>伤害</small>
          </div>
          {story && (
            <div>
              <b>{story.fights.length}</b>
              <small>波交战</small>
            </div>
          )}
          {story && (
            <div>
              <b>{story.events.filter((event) => event.kind === 'revive').length}</b>
              <small>次救援</small>
            </div>
          )}
        </div>
      </section>

      {!data.available || !story ? (
        <Section title="这局发生了什么">
          <p className="av-note">
            {data.reason === 'no_archive'
              ? '这局没有原始遥测归档（PUBG 只保留约 14 天），只能看到下面的战绩数据。'
              : '原始遥测读取失败，只能看到下面的战绩数据。'}
          </p>
        </Section>
      ) : (
        <>
          <Section title="这局发生了什么" hint="按时间顺序提炼的要点">
            <ul className="ms-highlights">
              {highlights.map((item) => (
                <li key={item.text} className={item.tone}>
                  {item.text}
                </li>
              ))}
            </ul>
          </Section>

          <Section
            title="时间线"
            hint="点击时间线任意位置，或拖动下面的滑块；▲击倒 ✕击杀 ＋救援 ▼被击倒 ●淘汰；彩条 = 存活，橙 = 倒地"
          >
            <div className="ms-tl-scroll">
              <Timeline
                data={data}
                story={story}
                time={time}
                onTime={(t) => {
                  setPlaying(false);
                  setTime(t);
                }}
                selectedFight={selectedFight}
                onFight={jumpToFight}
              />
            </div>
            <div className="ms-legend">
              <span className="alive">存活</span>
              <span className="down">倒地</span>
              <span className="win">胜</span>
              <span className="lose">负</span>
              <span className="draw">均势</span>
              <span className="skirmish">试探</span>
              <span className="teams">折线 = 场上剩余队伍数</span>
            </div>
          </Section>

          <div className="ms-map-grid">
            <Section
              title="行进路线与毒圈"
              hint="拖动滑块回放；白圈 = 下一个安全区，蓝圈 = 当前毒圈边界（会向白圈收缩）"
            >
              <RouteMap
                data={data}
                story={story}
                time={time}
                showEnemies={showEnemies}
                focusTeams={focusTeams}
                zoom={zoom}
                showImage={showImage}
              />
              <div className="ms-scrub">
                <button
                  type="button"
                  onClick={() => {
                    if (time >= duration) setTime(0);
                    setPlaying((value) => !value);
                  }}
                >
                  {playing ? '❚❚ 暂停' : '▶ 回放'}
                </button>
                <input
                  type="range"
                  min={0}
                  max={duration}
                  step={1}
                  value={Math.round(time)}
                  onChange={(event) => {
                    setPlaying(false);
                    setTime(Number(event.target.value));
                  }}
                  aria-label="回放时间"
                />
                <b>
                  {clock(time)} / {clock(duration)}
                </b>
              </div>
              <label className="ms-toggle">
                <input
                  type="checkbox"
                  checked={showImage}
                  onChange={(event) => setShowImage(event.target.checked)}
                />{' '}
                显示地图底图（官方地图；没有下载底图时自动退回网格）
              </label>
              <label className="ms-toggle">
                <input
                  type="checkbox"
                  checked={zoom}
                  onChange={(event) => setZoom(event.target.checked)}
                />{' '}
                放大到当前位置（跟随小队和正在交战的对手；默认关闭；点选一场交战时自动打开）
              </label>
              <label className="ms-toggle">
                <input
                  type="checkbox"
                  checked={showEnemies}
                  onChange={(event) => setShowEnemies(event.target.checked)}
                />{' '}
                显示敌人（灰点 = 其他队伍；交战中的对手会标出队号和近 2 分钟轨迹）
              </label>
              <div className="ms-now">
                {(() => {
                  const point = [...story.circle].reverse().find((item) => item.t <= time);
                  return point ? (
                    <span>
                      第 {point.phase ?? '—'} 圈 · 场上 {point.aliveTeams ?? '—'} 队{' '}
                      {point.alivePlayers ?? '—'} 人
                    </span>
                  ) : (
                    <span>开局阶段</span>
                  );
                })()}
                <span className="legend">
                  {data.players.map((row, index) => (
                    <i key={row.accountId} className={TONES[index % 4]}>
                      {row.name.replace(/^SG_LabmemNo/u, 'No.')}
                    </i>
                  ))}
                </span>
              </div>
            </Section>

            <Section
              title="交战回顾"
              hint="点一场，时间线和地图会跳到那一刻"
              className="ms-fights-panel"
            >
              <div className="ms-fights ms-scroll">
                {story.fights.map((fight) => {
                  const outcome = OUTCOME[fight.outcome];
                  const total = Math.max(1, fight.damageDealt + fight.damageTaken);
                  return (
                    <button
                      type="button"
                      key={fight.index}
                      className={`ms-fight ${outcome.tone} ${selectedFight === fight.index ? 'sel' : ''}`}
                      onClick={() => jumpToFight(fight.index)}
                    >
                      <span className="no">{fight.index}</span>
                      <span className="main">
                        <b>
                          {clock(fight.start)} · {fight.phase ? `第 ${fight.phase} 圈` : '开局'}
                          {fight.aliveTeams !== null ? ` · 场上 ${fight.aliveTeams} 队` : ''}
                        </b>
                        <small>{fightSentence(fight, name)}</small>
                        <span className="duel">
                          <i
                            className="dealt"
                            style={{ width: `${(fight.damageDealt / total) * 100}%` }}
                          />
                          <i
                            className="taken"
                            style={{ width: `${(fight.damageTaken / total) * 100}%` }}
                          />
                        </span>
                        <em>
                          打出 {fight.damageDealt} · 承受 {fight.damageTaken}
                        </em>
                        {fight.enemies.length > 0 && (
                          <span className="foes">
                            {fight.enemies.map((enemy) => (
                              <span className="foe" key={enemy.team}>
                                <b>{teamText(enemy.team)}</b>
                                {enemy.size > 0 ? ` ${enemy.size} 人` : ''}
                                {enemy.downed > 0 ? ` · 被打倒 ${enemy.downed}` : ''}
                                {enemy.damageToUs > 0 ? ` · 打了我们 ${enemy.damageToUs}` : ''}
                                {enemy.weapons.length ? ` · ${enemy.weapons.join('/')}` : ''}
                              </span>
                            ))}
                          </span>
                        )}
                      </span>
                      <span className="chip">{outcome.text}</span>
                    </button>
                  );
                })}
                {!story.fights.length && <p className="av-note">没有检测到与其他队伍的交战。</p>}
              </div>
            </Section>
          </div>
        </>
      )}

      <Section title="队员表现" hint="条形 = 在四人中的相对大小；有遥测时多出命中率等数据">
        <div className="ms-players">
          <div className="row head">
            <span>队员</span>
            <span>伤害</span>
            <span>击杀 / 击倒 / 助攻</span>
            <span>存活</span>
            <span>每分钟伤害</span>
            <span>命中率</span>
            <span>被击倒 / 救援</span>
          </div>
          {data.players.map((row, index) => (
            <div className={`row ${TONES[index % 4]}`} key={row.accountId}>
              <b>{row.name}</b>
              <span className="bar">
                <i style={{ width: `${(row.damage / maxDamage) * 100}%` }} />
                <em>{Math.round(row.damage)}</em>
              </span>
              <span>
                {row.kills} / {row.knocks} / {row.assists}
                {row.longestStreak !== null && row.longestStreak >= 2 ? (
                  <small> · 最长 {row.longestStreak} 连杀</small>
                ) : null}
              </span>
              <span className="bar thin">
                <i
                  style={{ width: `${Math.min(100, (row.survivalSeconds / matchLength) * 100)}%` }}
                />
                <em>{clock(row.survivalSeconds)}</em>
              </span>
              <span>{row.damagePerMinute === null ? '—' : row.damagePerMinute.toFixed(1)}</span>
              <span>{row.hitRate === null ? '—' : `${(row.hitRate * 100).toFixed(1)}%`}</span>
              <span>
                {row.timesDowned ?? '—'} / {row.revives}
              </span>
            </div>
          ))}
        </div>
      </Section>

      {story && story.downs.length > 0 && (
        <Section
          title="倒地记录"
          hint="每次被击倒的原因：看倒地前 20 秒谁打了谁；鼠标悬停在原因上看改进建议"
        >
          <ul className="ms-downs">
            {story.downs.map((down, index) => {
              const cause = data.downCauses.find((item) => item.key === down.cause);
              const bits = [
                down.attackerTeam !== null
                  ? `${teamText(down.attackerTeam)}${down.weapon ? ` 的 ${down.weapon}` : ''}${down.meters !== null && down.meters > 0 ? ` · ${down.meters} 米` : ''}`
                  : '',
                down.takenDamage > 0 || down.returnDamage > 0
                  ? `倒地前受到 ${down.takenDamage} 伤害、还手 ${down.returnDamage}`
                  : '',
                down.nearestTeammate !== null ? `最近队友 ${down.nearestTeammate} 米` : '',
                down.teamsNearby ? `300 米内另有 ${down.teamsNearby} 队` : '',
              ].filter(Boolean);
              const result =
                down.outcome === 'revived'
                  ? `${down.afterSeconds} 秒后被救起`
                  : down.outcome === 'died'
                    ? `${down.afterSeconds} 秒后被淘汰`
                    : '';
              return (
                <li key={index} className={toneOf(data, down.member)}>
                  <b>{clock(down.t)}</b>
                  <span className="who">{name(down.member)}</span>
                  <span className="what">
                    <i className={`cause ${down.cause}`} title={cause?.advice}>
                      {cause?.label ?? down.cause}
                    </i>
                    {bits.join(' · ')}
                    {result && <em className={down.outcome}>{result}</em>}
                  </span>
                </li>
              );
            })}
            {story.events
              .filter(
                (event) =>
                  event.kind === 'death' &&
                  !story.events.some(
                    (item) =>
                      item.kind === 'downed' &&
                      item.member === event.member &&
                      item.t < event.t &&
                      event.t - item.t < 200,
                  ),
              )
              .map((event, index) => (
                <li key={`d${index}`} className={toneOf(data, event.member)}>
                  <b>{clock(event.t)}</b>
                  <span className="who">{name(event.member)}</span>
                  <span className="what">
                    <i className="cause direct">直接淘汰</i>
                    {event.byPlayer
                      ? `被对手${event.weapon ? `用 ${event.weapon}` : ''}${event.meters !== null ? `在 ${event.meters} 米外` : ''}直接淘汰（没有倒地）。`
                      : '被环境淘汰。'}
                  </span>
                </li>
              ))}
          </ul>
        </Section>
      )}

      {story && story.rotation.epochs.length > 0 && (
        <Section
          title="本局转圈"
          hint="白圈出现后多久进到圈里，对比毒圈开始收缩的时间；负的提前量 = 被毒圈追上"
        >
          <div className="ms-rotation">
            <div className="row head">
              <span>圈</span>
              <span>刷新时离白圈</span>
              <span>进圈用时</span>
              <span>毒圈开始收缩</span>
              <span>提前量</span>
              <span>毒内 / 毒伤</span>
              <span>走了</span>
            </div>
            {story.rotation.epochs.map((epoch, index) => (
              <div className="row" key={index}>
                <b>第 {epoch.phase ?? '—'} 圈</b>
                <span>
                  {epoch.outsideAtStart === 0 ? '已在圈内' : `${epoch.outsideAtStart} 米`}
                </span>
                <span>
                  {epoch.enteredAfter === null ? (
                    <em className="bad">没进去</em>
                  ) : (
                    `${epoch.enteredAfter} 秒`
                  )}
                </span>
                <span>{epoch.shrinkAfter === null ? '—' : `${epoch.shrinkAfter} 秒后`}</span>
                <span className={epoch.margin === null ? '' : epoch.margin >= 0 ? 'good' : 'bad'}>
                  {epoch.margin === null
                    ? '—'
                    : `${epoch.margin >= 0 ? '+' : ''}${epoch.margin} 秒`}
                </span>
                <span className={epoch.blueDamage > 0 ? 'bad' : ''}>
                  {epoch.blueSeconds > 0 ? `${epoch.blueSeconds} 秒` : '—'}
                  {epoch.blueDamage > 0 ? ` · ${epoch.blueDamage}` : ''}
                </span>
                <span>
                  {epoch.distance >= 1000
                    ? `${(epoch.distance / 1000).toFixed(1)} km`
                    : `${epoch.distance} m`}
                  {epoch.vehicleShare !== null && epoch.vehicleShare > 0.3 ? ' 🚗' : ''}
                </span>
              </div>
            ))}
          </div>
          <p className="ms-rotation-sum">
            {story.rotation.landingToFight !== null
              ? `落地后 ${clock(story.rotation.landingToFight)} 打响第一场交战 · `
              : ''}
            共走 {(story.rotation.distance / 1000).toFixed(1)} km
            {story.rotation.vehicleShare !== null
              ? `（载具占 ${Math.round(story.rotation.vehicleShare * 100)}%）`
              : ''}{' '}
            · 毒里待了 {story.rotation.blueSeconds} 秒、吃了 {story.rotation.blueDamage} 点毒伤
            {story.rotation.circlesChecked > 0
              ? ` · 第 3 圈起 ${story.rotation.circlesChecked} 个圈里有 ${story.rotation.lateEntries} 个是毒圈开始收缩后才进的`
              : ''}
            。
          </p>
        </Section>
      )}
    </div>
  );
}
