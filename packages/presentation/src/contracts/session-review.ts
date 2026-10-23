/**
 * One squad play session (consecutive ranked matches with gaps under the session gap), reviewed for a group chat.
 * Every number is computed deterministically by the PUBG Domain; the renderer only formats and trims.
 */
export type SessionFindingTone = 'good' | 'bad' | 'neutral';
/** `clear` means the interval against the squad's own baseline excludes zero; `observation` is labelled as such. */
export type SessionFindingConfidence = 'clear' | 'observation';
export type SessionMemberTag = 'top_damage' | 'early_outs' | 'medic';

export interface SessionReviewFinding {
  metric: string;
  tone: SessionFindingTone;
  confidence: SessionFindingConfidence;
  text: string;
}

export interface SessionReviewMember {
  name: string;
  matches: number;
  kills: number;
  knocks: number;
  damagePerMatch: number;
  earlyOuts: number;
  revives: number;
  tags: SessionMemberTag[];
}

export interface SessionReviewMatchNote {
  matchId: string;
  rank: number | null;
  mapName: string;
  text: string;
}

export interface SessionReviewTimelineItem {
  atSeconds: number;
  text: string;
}

export interface SessionReviewPresentation {
  type: 'pubg_session_review';
  version: 1;
  sessionKey: string;
  squadLabel: string;
  timezone: string;
  startAt: string;
  endAt: string;
  matchCount: number;
  maps: Array<{ mapName: string; count: number }>;
  headline: string;
  /** Team placement per match in play order; null when PUBG did not report one. */
  placements: Array<number | null>;
  summary: {
    avgPlacement: number | null;
    baselineAvgPlacement: number | null;
    wins: number;
    top10: number;
    teamKnocks: number;
    avgTeamDamage: number;
  };
  findings: SessionReviewFinding[];
  members: SessionReviewMember[];
  bestMatch?: SessionReviewMatchNote;
  worstMatch?: SessionReviewMatchNote;
  /** Only for a one-match session: up to three moments of that match. */
  timeline?: SessionReviewTimelineItem[];
  suggestion?: string;
  coverage: { telemetry: number; total: number };
  link?: string;
  generatedAt: string;
}
