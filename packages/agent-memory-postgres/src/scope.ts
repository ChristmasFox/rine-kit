/**
 * Which memories an operation may touch. The host builds this from *authenticated* data (who is asking,
 * which room / space / tenant) after it has authorised the access; this package never derives it from
 * anything a model or a chat wrote. `kind` names the level (for example "user", "room", "space") and
 * `key` identifies it; `namespace` separates agents (Gate's bot account) sharing one database.
 */
export interface MemoryScope {
  namespace: string;
  kind: string;
  key: string;
}

/** What the host hands over for one trusted request. */
export interface MemoryAuthorization {
  scope: MemoryScope;
  /** Identifier of the trusted request / event this operation belongs to; stored as provenance. */
  eventId: string;
  /** When that event was received: a tombstone can only be restored by a later event. */
  receivedAt: Date;
}

export function boundedText(value: string, max: number, emojiSequence = false): string {
  if (typeof value !== 'string') throw new Error('agent_memory_input_invalid');
  const text = value.normalize('NFC').trim();
  if (!text || text.length > max || /[\p{Cc}\p{Cs}]/u.test(text))
    throw new Error('agent_memory_input_invalid');
  for (let i = 0; i < text.length; i += 1) {
    if (!/\p{Cf}/u.test(text[i]!)) continue;
    // ZWJ is legitimate between emoji pictographs, not in keys or words.
    if (
      !emojiSequence ||
      text[i] !== '‍' ||
      !/\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|️)?$/u.test(text.slice(0, i)) ||
      !/^\p{Extended_Pictographic}/u.test(text.slice(i + 1))
    )
      throw new Error('agent_memory_input_invalid');
  }
  return text;
}

/** The three scope parameters ($1..$3) of every scoped statement. */
export function scopeArgs(scope: MemoryScope): [string, string, string] {
  if (!/^[a-z][a-z0-9_]{0,31}$/u.test(scope.kind)) throw new Error('agent_memory_scope_invalid');
  return [boundedText(scope.namespace, 128), scope.kind, boundedText(scope.key, 256)];
}

export const SCOPE_FILTER = 'namespace=$1 AND scope_kind=$2 AND scope_key=$3';
