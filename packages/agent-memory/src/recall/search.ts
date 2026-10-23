import type { MemoryDraft, MemoryEntry } from '../contracts.js';

export const MAX_MEMORY_RESULTS = 24;

export class MemoryPolicyError extends Error {
  constructor(readonly code: 'input_invalid' | 'limit_invalid') {
    super(`memory_${code}`);
    this.name = 'MemoryPolicyError';
  }
}

function boundedText(value: string, max: number, emojiSequence = false): string {
  if (typeof value !== 'string') throw new MemoryPolicyError('input_invalid');
  const text = value.normalize('NFC').trim();
  if (!text || text.length > max || /[\p{Cc}\p{Cs}]/u.test(text))
    throw new MemoryPolicyError('input_invalid');
  for (let i = 0; i < text.length; i += 1) {
    if (!/\p{Cf}/u.test(text[i]!)) continue;
    if (
      !emojiSequence ||
      text[i] !== '\u200d' ||
      !/\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|\uFE0F)?$/u.test(text.slice(0, i)) ||
      !/^\p{Extended_Pictographic}/u.test(text.slice(i + 1))
    )
      throw new MemoryPolicyError('input_invalid');
  }
  return text;
}

export function normalizeMemoryKey(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/gu, '');
}

export function canonicalizeMemoryKey(value: string): string {
  const normalized = normalizeMemoryKey(boundedText(value, 96));
  if (!normalized || normalized.length > 96) throw new MemoryPolicyError('input_invalid');
  return normalized;
}

export function validateMemoryDraft(input: MemoryDraft): MemoryDraft {
  return {
    key: canonicalizeMemoryKey(input.key),
    content: boundedText(input.content, 800, true),
  };
}

/** Bounded script-aware terms used by the lexical candidate and fallback policies. */
export function memorySearchTokens(query: string): string[] {
  const normalized = boundedText(query, 240, true).toLocaleLowerCase('en-US');
  const tokens: string[] = [];
  for (const match of normalized.matchAll(/[\p{L}\p{N}]+/gu)) {
    for (const chunk of match[0]!.match(/\p{Script=Han}+|[^\p{Script=Han}]+/gu) ?? []) {
      if (/^\p{Script=Han}+$/u.test(chunk)) {
        const chars = Array.from(chunk);
        for (let index = 0; index + 1 < chars.length; index += 1)
          tokens.push(chars[index]! + chars[index + 1]!);
      } else if (chunk.length > 1) tokens.push(chunk);
    }
  }
  return [...new Set(tokens)].slice(0, 240);
}

export function rankMemoryEntries<T extends MemoryEntry>(
  entries: readonly T[],
  query: string,
  limit = 8,
): T[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_MEMORY_RESULTS)
    throw new MemoryPolicyError('limit_invalid');
  const search = boundedText(query, 240, true).toLocaleLowerCase('en-US');
  const words = memorySearchTokens(search);
  return entries
    .map((item, index) => {
      const haystack = (item.key + ' ' + item.content).toLocaleLowerCase('en-US');
      const score = haystack.includes(search)
        ? 1000
        : words.reduce((value, word) => value + (haystack.includes(word) ? 1 : 0), 0);
      return { item, index, score };
    })
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((match) => match.item);
}
