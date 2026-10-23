import type { OwnerNotificationPresentation } from '../contracts/owner.js';
import { formatDisplayTime } from '../time/format.js';
import { assertValid, validateOwnerNotificationPresentation } from '../validation/validate.js';

export interface OwnerNotificationRenderOptions {
  timezone?: string;
  now?: Date | string;
}

function fact(value: string | number | boolean | null): string {
  if (value === null) return '未知';
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
}

export function renderOwnerNotification(
  presentation: OwnerNotificationPresentation,
  options: OwnerNotificationRenderOptions = {},
): string {
  const validated = assertValid(validateOwnerNotificationPresentation(presentation));
  const lines = [validated.headline];
  if (validated.summary) lines.push('', validated.summary);
  if (validated.facts.length) {
    lines.push('', ...validated.facts.map((item) => `- ${item.label}：${fact(item.value)}`));
  }
  if (validated.links?.length) {
    lines.push('', ...validated.links.map((item) => `- ${item.label}：${item.url}`));
  }
  if (validated.dataUpdatedAt) {
    const timeOptions = {
      ...(options.timezone ? { timezone: options.timezone } : {}),
      now: options.now ?? validated.occurredAt,
    };
    const display = formatDisplayTime(validated.dataUpdatedAt, {
      ...timeOptions,
    });
    if (display) lines.push('', `数据更新时间：${display}`);
  }
  if (validated.worldLineClosing) lines.push('', 'El Psy Kongroo.');
  return lines.join('\n');
}
