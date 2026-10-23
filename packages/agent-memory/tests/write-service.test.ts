import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryWriteService } from '../src/write/service.js';
import type { MemoryWriteMetadata, MemoryWriteState } from '../src/contracts.js';

function state(overrides: Partial<MemoryWriteState> = {}): MemoryWriteState {
  return {
    key: 'favorite_map',
    content: 'Erangel',
    revision: 3,
    updatedAt: '2026-10-01T00:00:00.000Z',
    sourceEventId: 'old-event',
    sourceKind: 'user_confirmed',
    sourceReliability: 95,
    validUntil: null,
    revoked: false,
    ...overrides,
  };
}

function harness(
  initial: MemoryWriteState | null = null,
  options: {
    create?: 'created' | 'already_exists';
    revise?: boolean;
    rememberAgain?: boolean;
    forget?: boolean;
  } = {},
) {
  let current = initial;
  const calls: Array<{
    operation: string;
    key?: string;
    revision?: number;
    metadata?: MemoryWriteMetadata;
  }> = [];
  const service = new MemoryWriteService<string>({
    async getWriteState(auth, key) {
      assert.equal(auth, 'owner-dm');
      calls.push({ operation: 'get', key });
      return current?.key === key ? current : null;
    },
    async create(auth, draft, metadata) {
      assert.equal(auth, 'owner-dm');
      calls.push({ operation: 'create', key: draft.key, metadata });
      if ((options.create ?? 'created') === 'created' || options.create === 'already_exists') {
        current = state({ ...draft, revision: 1, sourceEventId: 'new-event', ...metadata });
      }
      return options.create ?? 'created';
    },
    async revise(auth, draft, revision, metadata) {
      assert.equal(auth, 'owner-dm');
      calls.push({ operation: 'revise', key: draft.key, revision, metadata });
      if (options.revise === false || current?.revision !== revision || current.revoked)
        return false;
      current = state({
        ...draft,
        revision: revision + 1,
        sourceEventId: 'new-event',
        ...metadata,
      });
      return true;
    },
    async rememberAgain(auth, draft, revision, metadata) {
      assert.equal(auth, 'owner-dm');
      calls.push({ operation: 'rememberAgain', key: draft.key, revision, metadata });
      if (options.rememberAgain === false || current?.revision !== revision || !current.revoked)
        return false;
      current = state({
        ...draft,
        revision: revision + 1,
        sourceEventId: 'new-event',
        ...metadata,
        revoked: false,
      });
      return true;
    },
    async forget(auth, key, revision) {
      assert.equal(auth, 'owner-dm');
      calls.push({ operation: 'forget', key, revision });
      if (options.forget === false || current?.revision !== revision || current.revoked)
        return false;
      current = state({
        key,
        content: '',
        revision: revision + 1,
        sourceEventId: 'new-event',
        revoked: true,
      });
      return true;
    },
  });
  return { service, calls, current: () => current };
}

test('generic write lifecycle creates, detects idempotent create races, and validates revision corrections', async () => {
  const created = harness();
  assert.deepEqual(
    await created.service.remember(
      'owner-dm',
      {
        operation: 'remember',
        key: 'Favorite Map',
        content: 'Erangel',
        validUntil: null,
      },
      { sourceEventId: 'new-event' },
    ),
    { status: 'created' },
  );
  assert.equal(created.current()?.key, 'favorite_map');
  assert.deepEqual(created.calls.find((call) => call.operation === 'create')?.metadata, {
    sourceKind: 'user_confirmed',
    sourceReliability: 95,
    validUntil: null,
  });

  const race = harness(null, { create: 'already_exists' });
  assert.deepEqual(
    await race.service.remember(
      'owner-dm',
      {
        operation: 'remember',
        key: 'favorite_map',
        content: 'Erangel',
      },
      { sourceEventId: 'new-event' },
    ),
    { status: 'created' },
  );

  const current = harness(state());
  assert.deepEqual(
    await current.service.remember(
      'owner-dm',
      {
        operation: 'correct',
        key: 'favorite_map',
        content: 'Miramar',
        expectedRevision: 2,
      },
      { sourceEventId: 'new-event' },
    ),
    { status: 'not_found' },
  );
  assert.equal(
    current.calls.some((call) => call.operation === 'revise'),
    false,
  );
  assert.deepEqual(
    await current.service.remember(
      'owner-dm',
      {
        operation: 'correct',
        key: 'favorite_map',
        content: 'Miramar',
        expectedRevision: 3,
      },
      { sourceEventId: 'new-event' },
    ),
    { status: 'revised' },
  );
  assert.equal(current.current()?.revision, 4);
});

test('generic write lifecycle only restores later tombstone revisions and forgets with a revision fence', async () => {
  const tombstone = harness(state({ content: '', revision: 4, revoked: true }), {
    rememberAgain: true,
  });
  assert.deepEqual(
    await tombstone.service.remember(
      'owner-dm',
      {
        operation: 'remember',
        key: 'favorite_map',
        content: 'Erangel',
        expectedRevision: 4,
      },
      { sourceEventId: 'new-event' },
    ),
    { status: 'revised' },
  );

  const forgotten = harness(state(), { forget: true });
  assert.deepEqual(
    await forgotten.service.forget(
      'owner-dm',
      { key: 'favorite_map', expectedRevision: 3 },
      { sourceEventId: 'new-event' },
    ),
    { status: 'forgotten' },
  );
  assert.deepEqual(
    forgotten.calls.find((call) => call.operation === 'forget'),
    {
      operation: 'forget',
      key: 'favorite_map',
      revision: 3,
    },
  );

  const staleForget = harness(state());
  assert.deepEqual(
    await staleForget.service.forget(
      'owner-dm',
      { key: 'favorite_map', expectedRevision: 2 },
      { sourceEventId: 'new-event' },
    ),
    { status: 'not_found' },
  );
  assert.equal(
    staleForget.calls.some((call) => call.operation === 'forget'),
    false,
  );
});
