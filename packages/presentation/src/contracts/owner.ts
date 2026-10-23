import type {
  PresentationFact,
  PresentationLink,
  WorldlineSignificance,
  WorldlineTheme,
} from '../worldline/contracts.js';

export type OwnerNotificationSeverity = 'info' | 'success' | 'warning' | 'error';

export type OwnerNotificationFact = PresentationFact;
export type OwnerNotificationLink = PresentationLink;

export interface OwnerNotificationPresentation {
  type: 'owner_notification';
  eventType: string;
  severity: OwnerNotificationSeverity;
  significance: WorldlineSignificance;
  theme: WorldlineTheme;
  eventKey: string;
  source: string;
  headline: string;
  facts: OwnerNotificationFact[];
  links?: OwnerNotificationLink[];
  summary?: string;
  dataUpdatedAt?: string;
  occurredAt: string;
  worldLineClosing?: boolean;
}
