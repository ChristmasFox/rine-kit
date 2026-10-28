import { redactSensitiveText } from '@rine-kit/pubg-intelligence';

/** A player name safe to show on a page anyone with the link can open (phone numbers and the like are hidden). */
export function safePlayerName(value: string, index: number): string {
  const normalized = redactSensitiveText(value.trim()).replace(/\[手机号已隐藏\]/gu, '匿名队员');
  return normalized || `队员 ${index + 1}`;
}
