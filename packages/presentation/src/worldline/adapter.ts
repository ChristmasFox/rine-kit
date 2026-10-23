import type { OwnerNotificationPresentation } from '../contracts/owner.js';
import { assertValid, validateOwnerNotificationPresentation } from '../validation/validate.js';
import type { WorldlineNotificationIntent } from './contracts.js';
import { WORLDLINE_THEME_LABELS } from './contracts.js';
import { selectWorldlineTheme } from './policy.js';

function validateIntent(intent: WorldlineNotificationIntent): WorldlineNotificationIntent {
  if (intent.type !== 'worldline_notification_intent')
    throw new Error('worldline intent type is invalid');
  if (
    !intent.eventType.trim() ||
    !intent.kind.trim() ||
    !intent.eventKey.trim() ||
    !intent.source.trim()
  )
    throw new Error('worldline intent identity is required');
  if (!Number.isFinite(Date.parse(intent.occurredAt)))
    throw new Error('worldline intent occurredAt must be an ISO timestamp');
  if (intent.dataUpdatedAt !== undefined && !Number.isFinite(Date.parse(intent.dataUpdatedAt)))
    throw new Error('worldline intent dataUpdatedAt must be an ISO timestamp');
  const occurrenceCount = intent.correlation?.occurrenceCount ?? intent.occurrenceCount;
  if (occurrenceCount !== undefined && (!Number.isInteger(occurrenceCount) || occurrenceCount < 1))
    throw new Error('worldline intent occurrenceCount must be a positive integer');
  if (
    intent.correlation?.windowMinutes !== undefined &&
    (!Number.isInteger(intent.correlation.windowMinutes) || intent.correlation.windowMinutes < 1)
  )
    throw new Error('worldline intent windowMinutes must be a positive integer');
  return intent;
}

export function adaptWorldlineNotification(
  intent: WorldlineNotificationIntent,
): OwnerNotificationPresentation {
  const valid = validateIntent(intent);
  const theme = selectWorldlineTheme(valid);
  const label = WORLDLINE_THEME_LABELS[theme];
  const headline = valid.headline?.trim()
    ? `Amadeus • ${label} · ${valid.headline.trim()}`
    : `Amadeus • ${label}`;
  return assertValid(
    validateOwnerNotificationPresentation({
      type: 'owner_notification',
      eventType: valid.eventType,
      severity: valid.severity,
      significance: valid.significance,
      theme,
      eventKey: valid.eventKey,
      source: valid.source,
      headline,
      facts: valid.facts,
      ...(valid.summary?.trim() ? { summary: valid.summary.trim() } : {}),
      ...(valid.links?.length ? { links: valid.links } : {}),
      ...(valid.dataUpdatedAt ? { dataUpdatedAt: valid.dataUpdatedAt } : {}),
      occurredAt: valid.occurredAt,
      ...(valid.worldLineClosing ? { worldLineClosing: true } : {}),
    }),
  );
}
