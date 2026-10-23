import type { OwnerNotificationRenderOptions } from '../renderers/owner.js';
import { renderOwnerNotification } from '../renderers/owner.js';
import type { WorldlineNotificationIntent } from './contracts.js';
import { adaptWorldlineNotification } from './adapter.js';

export function renderWorldlineNotification(
  intent: WorldlineNotificationIntent,
  options: OwnerNotificationRenderOptions = {},
): string {
  return renderOwnerNotification(adaptWorldlineNotification(intent), options);
}
