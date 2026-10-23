export const WORLDLINE_THEMES = [
  'worldline_observation',
  'worldline_divergence',
  'worldline_convergence',
  'dmail',
  'reading_steiner',
  'attractor_field',
  'sern_alert',
  'ibn_5100',
  'time_leap',
  'operation_skuld',
  'rounder_activity',
] as const;

export type WorldlineTheme = (typeof WORLDLINE_THEMES)[number];

export const WORLDLINE_THEME_LABELS: Record<WorldlineTheme, string> = {
  worldline_observation: '世界线观测',
  worldline_divergence: '世界线偏移',
  worldline_convergence: '世界线收束',
  dmail: 'D-Mail',
  reading_steiner: 'Reading Steiner',
  attractor_field: '吸引子场',
  rounder_activity: 'Rounder 活动',
  sern_alert: 'SERN 警报',
  ibn_5100: 'IBN 5100',
  time_leap: '时间跳跃',
  operation_skuld: 'Operation Skuld · 斯库尔德行动',
};

export const WORLDLINE_SIGNIFICANCES = ['minor', 'notable', 'major', 'critical'] as const;
export type WorldlineSignificance = (typeof WORLDLINE_SIGNIFICANCES)[number];

export type PresentationScalar = string | number | boolean | null;

export interface PresentationFact {
  label: string;
  value: PresentationScalar;
  evidenceRefs: string[];
}

export interface PresentationLink {
  label: string;
  url: string;
  evidenceRefs?: string[];
}

export interface WorldlineNotificationIntent {
  type: 'worldline_notification_intent';
  eventType: string;
  kind: string;
  severity: 'info' | 'success' | 'warning' | 'error';
  significance: WorldlineSignificance;
  eventKey: string;
  source: string;
  headline?: string;
  summary?: string;
  facts: PresentationFact[];
  links?: PresentationLink[];
  dataUpdatedAt?: string;
  occurredAt: string;
  worldLineClosing?: boolean;
  occurrenceCount?: number;
  correlation?: {
    fingerprint?: string;
    occurrenceCount?: number;
    windowMinutes?: number;
  };
  operation?: {
    code?: string;
    phase?: string;
  };
}

export const WORLDLINE_PRODUCER_REGISTRY = [
  'product-radar',
  'market',
  'pubg-sync',
  'release',
  'codex',
  'vps',
  'vps-traffic-fuse',
  'homelab',
  'nas',
  'media',
  'storage',
] as const;

export type WorldlineProducer = (typeof WORLDLINE_PRODUCER_REGISTRY)[number];
