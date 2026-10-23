import { canonicalizeMemoryKey, validateMemoryDraft } from '../recall/search.js';
import type {
  ExplicitMemoryWrite,
  MemoryDraft,
  MemoryForgetRequest,
  MemoryWriteMetadata,
  MemoryWriteResult,
  MemoryWriteState,
} from '../contracts.js';

export interface MemoryWriteStoragePort<TAuthorization> {
  getWriteState(authorization: TAuthorization, key: string): Promise<MemoryWriteState | null>;
  create(
    authorization: TAuthorization,
    draft: MemoryDraft,
    metadata: MemoryWriteMetadata,
  ): Promise<'created' | 'already_exists'>;
  revise(
    authorization: TAuthorization,
    draft: MemoryDraft,
    expectedRevision: number,
    metadata: MemoryWriteMetadata,
  ): Promise<boolean>;
  rememberAgain(
    authorization: TAuthorization,
    draft: MemoryDraft,
    expectedRevision: number,
    metadata: MemoryWriteMetadata,
  ): Promise<boolean>;
  forget(authorization: TAuthorization, key: string, expectedRevision: number): Promise<boolean>;
}

export interface MemoryWriteContext {
  sourceEventId: string;
}

function normalizeMetadata(input: MemoryWriteMetadata): MemoryWriteMetadata {
  const sourceKind = input.sourceKind ?? 'user_confirmed';
  if (!['trusted_ingress', 'user_confirmed', 'system_verified', 'unknown'].includes(sourceKind)) {
    throw new Error('memory_source_kind_invalid');
  }
  const sourceReliability = input.sourceReliability ?? (sourceKind === 'user_confirmed' ? 95 : 80);
  if (
    !Number.isSafeInteger(sourceReliability) ||
    sourceReliability < 0 ||
    sourceReliability > 100
  ) {
    throw new Error('memory_source_reliability_invalid');
  }
  let validUntil: string | null = null;
  if (input.validUntil != null) {
    const timestamp = Date.parse(input.validUntil);
    if (!Number.isFinite(timestamp)) throw new Error('memory_valid_until_invalid');
    validUntil = new Date(timestamp).toISOString();
  }
  return { sourceKind, sourceReliability, validUntil };
}

function validContext(context: MemoryWriteContext): boolean {
  return (
    typeof context.sourceEventId === 'string' &&
    context.sourceEventId.trim().length > 0 &&
    context.sourceEventId.length <= 256
  );
}

/** Generic explicit write lifecycle; the host port enforces its identity and storage fences. */
export class MemoryWriteService<TAuthorization> {
  constructor(private readonly storage: MemoryWriteStoragePort<TAuthorization>) {}

  async remember(
    authorization: TAuthorization,
    write: ExplicitMemoryWrite,
    context: MemoryWriteContext,
    metadata: MemoryWriteMetadata = {},
  ): Promise<MemoryWriteResult> {
    if (!validContext(context)) return { status: 'not_found' };
    const draft = validateMemoryDraft(write);
    const normalized = normalizeMetadata({
      sourceKind: 'user_confirmed',
      sourceReliability: 95,
      validUntil: write.validUntil ?? null,
      ...metadata,
    });
    const state = await this.storage.getWriteState(authorization, draft.key);

    if (write.operation === 'correct') {
      if (!state || state.revoked || write.expectedRevision !== state.revision)
        return { status: 'not_found' };
      return (await this.storage.revise(authorization, draft, state.revision, normalized))
        ? { status: 'revised' }
        : { status: 'not_found' };
    }

    if (state?.revoked) {
      if (write.expectedRevision !== state.revision) return { status: 'not_found' };
      return (await this.storage.rememberAgain(authorization, draft, state.revision, normalized))
        ? { status: 'revised' }
        : { status: 'not_found' };
    }
    if (state)
      return state.content === draft.content
        ? { status: 'already_present' }
        : { status: 'not_found' };

    if ((await this.storage.create(authorization, draft, normalized)) === 'created')
      return { status: 'created' };
    const current = await this.storage.getWriteState(authorization, draft.key);
    return current &&
      !current.revoked &&
      current.sourceEventId === context.sourceEventId &&
      current.content === draft.content
      ? { status: 'created' }
      : { status: 'not_found' };
  }

  async forget(
    authorization: TAuthorization,
    request: MemoryForgetRequest,
    context: MemoryWriteContext,
  ): Promise<MemoryWriteResult> {
    if (!validContext(context)) return { status: 'not_found' };
    const key = canonicalizeMemoryKey(request.key);
    const state = await this.storage.getWriteState(authorization, key);
    if (
      !state ||
      state.revoked ||
      (request.expectedRevision !== undefined && request.expectedRevision !== state.revision)
    )
      return { status: 'not_found' };
    const forgotten = await this.storage.forget(authorization, key, state.revision);
    const finalState = await this.storage.getWriteState(authorization, key);
    return forgotten || finalState?.revoked ? { status: 'forgotten' } : { status: 'not_found' };
  }
}
