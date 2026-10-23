import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  MemoryConsolidationConsentService,
  MemoryConsolidationWorker,
  migrateMemoryDatabase,
  PostgresMemoryStore,
  purgeExpiredMemoryData,
  type MemoryConsolidationPlanner,
} from '../src/index.js';
import { auth, DATABASE_URL, freshPool } from './helpers.js';

const day = (n: number) => new Date(Date.now() - n * 86_400_000);
const observation = (eventId: string, content: string, at: Date) => ({
  content,
  observedAt: at.toISOString(),
  evidence: [{ id: eventId, observedAt: at.toISOString(), source: 'conversation' as const }],
});

/** A planner that learns "<x>" from every message of the form "我喜欢<x>". */
const planner: MemoryConsolidationPlanner = {
  async plan({ messages }) {
    return messages.flatMap((m) => {
      const hit = /我喜欢(.+)/u.exec(m.content);
      return hit
        ? [
            {
              confidence: 'high',
              subject: 'self',
              kind: 'stable_preference',
              key: 'favorite_game',
              content: hit[0],
              evidence: hit[0],
              validity: 'stable',
            },
          ]
        : [];
    });
  },
};

describe(
  'automatic learning',
  { skip: !DATABASE_URL && 'MEMORY_TEST_DATABASE_URL not set' },
  () => {
    let db: Awaited<ReturnType<typeof freshPool>>;
    before(async () => {
      db = await freshPool('consolidation');
      await migrateMemoryDatabase(db.pool);
    });
    after(async () => {
      await db.drop();
    });

    const service = () => new MemoryConsolidationConsentService(db.pool, 'rine', 'user');
    const worker = () => new MemoryConsolidationWorker(db.pool, 'rine', planner);

    async function run(workflow: 'light' | 'rem', times = 6): Promise<string[]> {
      const out: string[] = [];
      for (let i = 0; i < times; i++) {
        const r = await worker().processNext(workflow);
        out.push(r.status);
        if (r.status === 'SKIPPED_NO_ELIGIBLE_CORPUS') break;
      }
      return out;
    }

    it('turns repeated observations on different days into a long-term memory, never from a single mention', async () => {
      const a = (id: string, at: Date) => auth('user', 'learner', id, at);
      const svc = service();
      assert.equal(
        await svc.observe(a('o1', day(3)), observation('o1', '我喜欢绝地求生', day(3))),
        2,
      );
      assert.deepEqual(await run('light'), ['processed', 'SKIPPED_NO_ELIGIBLE_CORPUS']);
      // One observation is a candidate, not a memory.
      assert.deepEqual(await worker().processDeep(), {
        status: 'processed',
        inspected: 1,
        promoted: 0,
        rejected: 0,
        deferred: 1,
      });
      const store = new PostgresMemoryStore(db.pool);
      assert.equal(await store.getWriteState(a('x', new Date()), 'favorite_game'), null);

      assert.equal(
        await svc.observe(a('o2', day(2)), observation('o2', '我喜欢绝地求生', day(2))),
        2,
      );
      await run('light');
      const deep = await worker().processDeep();
      assert.deepEqual(deep, {
        status: 'processed',
        inspected: 1,
        promoted: 1,
        rejected: 0,
        deferred: 0,
      });
      const memory = await store.getWriteState(a('y', new Date()), 'favorite_game');
      assert.equal(memory?.content, '我喜欢绝地求生');
      assert.equal(memory?.sourceKind, 'trusted_ingress');
      assert.equal(memory?.sourceReliability, 85);
      // The learned memory is queued for embedding like any other write.
      const jobs = await db.pool.query(
        `SELECT count(*)::int n FROM agent_memory_embedding_jobs j JOIN agent_memory_entries m USING (memory_id) WHERE m.scope_key='learner'`,
      );
      assert.ok(jobs.rows[0].n >= 1);
    });

    it("only admits what the trusted request itself said, for the service's own scope", async () => {
      const svc = service();
      const at = new Date();
      // Evidence that is not this request, another scope kind, and another namespace admit nothing.
      assert.equal(
        await svc.observe(
          auth('user', 'guard', 'g1', at),
          observation('other-event', '我喜欢火锅', at),
        ),
        0,
      );
      assert.equal(
        await svc.observe(auth('room', 'guard', 'g2', at), observation('g2', '我喜欢火锅', at)),
        0,
      );
      assert.equal(
        await svc.observe(
          auth('user', 'guard', 'g3', at, 'another-agent'),
          observation('g3', '我喜欢火锅', at),
        ),
        0,
      );
      const n = await db.pool.query(
        `SELECT count(*)::int n FROM agent_memory_observations WHERE scope_key='guard'`,
      );
      assert.equal(n.rows[0].n, 0);
    });

    it('rejects sensitive or third-party text and honours consent revocation', async () => {
      const svc = service();
      const a = (id: string, at: Date) => auth('user', 'private', id, at);
      // Learning can be switched off per workflow; turning it off clears unconfirmed candidates.
      await svc.observe(a('p1', day(1)), observation('p1', '我喜欢蓝色键盘', day(1)));
      await run('light');
      assert.equal((await svc.pendingCandidates(a('q', new Date()))).length, 1);
      assert.deepEqual(await svc.setConsent(a('p2', new Date()), 'light', false), {
        enabled: false,
        version: 2,
      });
      assert.equal((await svc.pendingCandidates(a('q2', new Date()))).length, 0);
      assert.equal((await svc.getConsent(a('q3', new Date()))).light.enabled, false);
      // New observations are no longer queued for the disabled workflow.
      assert.equal(
        await svc.observe(a('p3', new Date()), observation('p3', '我喜欢红色鼠标', new Date())),
        1,
      );

      // Sensitive content never becomes a candidate, even when the planner proposes it.
      const sneaky: MemoryConsolidationPlanner = {
        plan: async () => [
          {
            confidence: 'high',
            subject: 'self',
            kind: 'verifiable_fact',
            key: 'phone',
            content: '我的手机号是13800138000',
            evidence: '我的手机号是13800138000',
            validity: '30_days',
          },
        ],
      };
      await svc.observe(
        auth('user', 'sneaky', 's1', new Date()),
        observation('s1', '我的手机号是13800138000', new Date()),
      );
      const w = new MemoryConsolidationWorker(db.pool, 'rine', sneaky);
      const r = await w.processNext('rem');
      assert.equal(r.status, 'processed');
      assert.equal((r as { candidates: number }).candidates, 0);
    });

    it('lets the member confirm or reject a candidate, and forgetting a key drops its candidates', async () => {
      const svc = service();
      const a = (id: string, at = new Date()) => auth('user', 'confirmer', id, at);
      await svc.observe(a('c1', day(1)), observation('c1', '我喜欢夜间模式', day(1)));
      await run('light');
      const [candidate] = await svc.pendingCandidates(a('c2'));
      assert.ok(candidate);
      assert.equal(await svc.confirmCandidate(a('c3'), candidate.candidateId), 'promoted');
      assert.equal(await svc.confirmCandidate(a('c3'), candidate.candidateId), 'already_promoted');
      const store = new PostgresMemoryStore(db.pool);
      const saved = await store.getWriteState(a('c4'), 'favorite_game');
      assert.equal(saved?.sourceKind, 'user_confirmed');
      // Another member cannot touch it.
      assert.equal(
        await svc.confirmCandidate(auth('user', 'intruder', 'i1'), candidate.candidateId),
        'unavailable',
      );
      assert.equal(
        await svc.rejectCandidate(auth('user', 'intruder', 'i2'), candidate.candidateId),
        false,
      );
      // Forgetting the key also removes the candidate that produced it.
      assert.equal(await store.forget(a('c5'), 'favorite_game'), true);
      const left = await db.pool.query(
        `SELECT status, content FROM agent_memory_consolidation_candidates WHERE scope_key='confirmer'`,
      );
      assert.deepEqual(left.rows, [{ status: 'rejected', content: '[rejected]' }]);
    });
  },
);

describe('retention', { skip: !DATABASE_URL && 'MEMORY_TEST_DATABASE_URL not set' }, () => {
  it('purges expired observations, admissions, evidence and candidates but keeps live ones', async () => {
    const db = await freshPool('retention');
    try {
      await migrateMemoryDatabase(db.pool);
      const svc = new MemoryConsolidationConsentService(db.pool, 'rine', 'user');
      const at = new Date();
      await svc.observe(auth('user', 'keep', 'k1', at), observation('k1', '我喜欢茶', at));
      await svc.observe(auth('user', 'old', 'o1', at), observation('o1', '我喜欢咖啡', at));
      await db.pool.query(
        `UPDATE agent_memory_observations SET expires_at=now()-interval '1 day' WHERE scope_key='old'`,
      );
      await db.pool.query(
        `UPDATE agent_memory_consolidation_admissions SET expires_at=now()-interval '1 day' WHERE scope_key='old'`,
      );
      const purged = await purgeExpiredMemoryData(db.pool);
      assert.deepEqual(purged, { observations: 1, admissions: 2, usageSignals: 0, candidates: 0 });
      const left = await db.pool.query(`SELECT scope_key FROM agent_memory_observations`);
      assert.deepEqual(left.rows, [{ scope_key: 'keep' }]);
    } finally {
      await db.drop();
    }
  });
});
