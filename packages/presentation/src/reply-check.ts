import type { PubgPresentation } from './contracts/pubg.js';
import { assignStatTitles, formatMetricNumber } from './renderers/pubg.js';

/*
 * Did a retold reply keep the facts its block must carry? Names are not checked (the agent swaps account names for
 * 称呼); the numbers and titles that identify each card or direction are. Only the layouts whose guide demands the
 * whole block (战绩 cards, the 队内误伤账本) are checked; narrower answers are left alone.
 */

function numberForms(key: string, value: number): string[] {
  const shown = formatMetricNumber(key, value);
  // "2743.0" may be written "2743"; any other rounding is a changed number.
  return shown.endsWith('.0') ? [shown, shown.slice(0, -2)] : [shown];
}

function present(reply: string, forms: string[]): boolean {
  return forms.some((form) =>
    new RegExp(`(?<![\\d.])${form.replace('.', '\\.')}(?![\\d])`, 'u').test(reply),
  );
}

/** Short labels of the facts the reply dropped; empty when it kept them all or the layout is not checked. */
export function missingReplyFacts(presentation: PubgPresentation, reply: string): string[] {
  if (presentation.status !== 'ok' && presentation.status !== 'partial') return [];
  const missing: string[] = [];
  if (presentation.type === 'pubg_stats') {
    const titles = assignStatTitles(presentation.rows);
    presentation.rows.forEach((row, index) => {
      for (const key of ['kd', 'damage'] as const) {
        const value = row.values[key];
        if (
          typeof value === 'number' &&
          Number.isFinite(value) &&
          !present(reply, numberForms(key, value))
        )
          missing.push(
            `${row.label} 的${key === 'kd' ? ' KD' : '伤害'} ${formatMetricNumber(key, value)}`,
          );
      }
      for (const title of titles.get(index) ?? [])
        if (!reply.includes(title)) missing.push(`${row.label} 的称号「${title}」`);
    });
    if (presentation.rows.length >= 2 && !reply.includes('团队合计')) missing.push('团队合计');
  } else if (presentation.type === 'pubg_team_damage') {
    for (const direction of presentation.directions) {
      if (direction.damage !== null && !present(reply, numberForms('damage', direction.damage)))
        missing.push(
          `${direction.actor} → ${direction.victim} 的 ${formatMetricNumber('damage', direction.damage)} 伤害`,
        );
    }
  }
  return missing;
}
