export type PubgPresentationStatus = 'ok' | 'partial' | 'no_matches' | 'error';

export interface PubgSourceRangeSegment {
  label: string;
  from: string | null;
  to: string | null;
}

export interface PubgSourceRange {
  from: string | null;
  to: string | null;
  segments?: PubgSourceRangeSegment[];
}

export interface PubgPresentationBase {
  status: PubgPresentationStatus;
  dataUpdatedAt: string;
  sourceRange?: PubgSourceRange;
  coverage?: PubgPresentationCoverage;
}

/** Provenance facts passed through from the shared Domain envelope. */
export interface PubgPresentationCoverage {
  status: string;
  complete: boolean;
  freshness: 'fresh' | 'stale' | 'unknown';
  checkedAt: string | null;
  coverageStart: string | null;
  coverageEnd: string | null;
  sourceUnavailable: boolean;
}

export interface PresentationTextItem {
  text: string;
  evidenceRefs: string[];
}

export type PubgPresentationScalar = string | number | null;

export interface PubgMetricRow {
  label: string;
  values: Record<string, PubgPresentationScalar>;
  position?: number | null;
  evidenceRefs: string[];
}

export interface PubgMatchReviewOverview {
  placement: number | null;
  kills: number | null;
  assists: number | null;
  damage: number | null;
  dbnos: number | null;
  revives: number | null;
}

export interface PubgMatchReviewPresentation extends PubgPresentationBase {
  type: 'pubg_match_review';
  headline: string;
  overview: PubgMatchReviewOverview;
  keyMoments: PresentationTextItem[];
  highlights: PresentationTextItem[];
  improvements: PresentationTextItem[];
  analysis: string;
  evidenceRefs: string[];
}

export interface PubgPeriodReviewMatch {
  matchId: string;
  label: string;
  startedAt: string | null;
  placement: number | null;
}

export interface PubgPeriodReviewPresentation extends PubgPresentationBase {
  type: 'pubg_period_review';
  period: {
    label: string;
    displayDate?: string;
  };
  summary: string;
  orderedMatches: PubgPeriodReviewMatch[];
  highlights: PresentationTextItem[];
  patterns: PresentationTextItem[];
  analysis: string;
  evidenceRefs: string[];
}

export interface PubgStatsPresentation extends PubgPresentationBase {
  type: 'pubg_stats';
  headline: string;
  operation: string;
  groupBy: string;
  summary: string;
  rows: PubgMetricRow[];
  evidenceRefs: string[];
}

export interface PubgMatchListItem {
  matchId: string;
  startedAt: string | null;
  mapName: string;
  gameMode: string;
  placement: number | null;
  summary: string;
  evidenceRefs: string[];
}

export interface PubgMatchListPresentation extends PubgPresentationBase {
  type: 'pubg_match_list';
  headline: string;
  summary: string;
  matches: PubgMatchListItem[];
  evidenceRefs: string[];
}

export interface PubgComparisonSegment {
  label: string;
  sourceRange?: PubgSourceRange;
  rows: PubgMetricRow[];
}

export interface PubgComparisonPresentation extends PubgPresentationBase {
  type: 'pubg_comparison';
  headline: string;
  summary: string;
  rows: PubgMetricRow[];
  segments: PubgComparisonSegment[];
  evidenceRefs: string[];
}

export interface PubgMatchDetailPlayer {
  label: string;
  values: Record<string, PubgPresentationScalar>;
  evidenceRefs: string[];
}

export interface PubgMatchDetailPresentation extends PubgPresentationBase {
  type: 'pubg_match_detail';
  headline: string;
  matchId: string;
  startedAt: string | null;
  mapName: string;
  gameMode: string;
  duration: number | null;
  players: PubgMatchDetailPlayer[];
  evidenceRefs: string[];
}

export interface PubgTeamDamageDirection {
  actor: string;
  victim: string;
  hitCount: number | null;
  damage: number | null;
  knownHitCount?: number;
  knownDamage?: number;
  complete: boolean;
  evidenceRefs: string[];
}

export interface PubgTeamDamageActorTotal {
  actor: string;
  damage: number | null;
  hitCount: number | null;
  knownDamage: number;
  knownHitCount: number;
  complete: boolean;
  position: number;
  evidenceRefs: string[];
}

/** One kind of team hit (飞踢, 重拳, a vehicle ram, a gun) with its count and damage. */
export interface PubgTeamDamageSlice {
  label: string;
  hitCount: number;
  damage: number;
}

export interface PubgTeamDamagePair {
  actor: string;
  victim: string;
  hitCount: number;
  damage: number;
}

/** The match with the most team damage in the period, for the 名场面 lines. */
export interface PubgTeamDamageHighlight {
  label: string;
  hitCount: number;
  damage: number;
  pairs: PubgTeamDamagePair[];
}

/** Detail behind the totals, read from the per-match telemetry events; absent when no events were returned. */
export interface PubgTeamDamageLedger {
  sources: PubgTeamDamageSlice[];
  /** Aligned with `directions`: how each direction's hits break down by kind. */
  directionSources: PubgTeamDamageSlice[][];
  highlights: PubgTeamDamageHighlight[];
  /** Players hit by teammates who never hit a teammate themselves. */
  quiet: string[];
}

export interface PubgTeamDamagePresentation extends PubgPresentationBase {
  type: 'pubg_team_damage';
  ledger?: PubgTeamDamageLedger;
  headline: string;
  direction: string;
  source: string | null;
  meleeKind: string | null;
  totalHitCount: number | null;
  totalDamage: number | null;
  directions: PubgTeamDamageDirection[];
  actorTotals?: PubgTeamDamageActorTotal[];
  rankingBasis?: 'damage' | 'knownDamage';
  summary: string;
  evidenceRefs: string[];
}

export interface PubgStatusPresentation extends PubgPresentationBase {
  type: 'pubg_status';
  headline: string;
  message: string;
  errorCode?: string;
  evidenceRefs: string[];
}

export type PubgPresentation =
  | PubgStatsPresentation
  | PubgMatchListPresentation
  | PubgComparisonPresentation
  | PubgMatchDetailPresentation
  | PubgMatchReviewPresentation
  | PubgPeriodReviewPresentation
  | PubgTeamDamagePresentation
  | PubgStatusPresentation;
