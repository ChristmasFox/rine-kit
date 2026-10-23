# @rine-kit/pubg-postgres

PostgreSQL 存储层，实现 `@rine-kit/pubg-domain` 的 `PubgRepositoryPort`：比赛与队员成绩、
遥测特征、预取进度、会话上下文与结果集、同步队列、API 额度表。提取自 Gate 的 `pubg-saas`，
逻辑与 SQL 保持一致；去掉了 KOOK 专属的租户元组与会话表。

## 宿主要提供什么

- `tenantId`：不透明字符串，由宿主授权后给出（RINE：部署/命名空间）。
- `TeamContext`：小队与成员（RINE：一个房间 = 一个小队）。
- `TrustedConversationScope`：`{ kind, actorId, channelId, sessionId }`，必须由服务端生成，
  不得取自模型/工具参数。
- `authorize(client, scope)`：在每次受限读写的事务里、与团队行同一连接上执行；不允许就抛错。
  请对授权依据（绑定、成员关系）加 `FOR SHARE`，这样撤权要么先提交（读被拒绝），要么等读完成。

## 使用

```ts
import { migratePubgDatabase, PostgresPubgRepository, PublicSyncQueue } from '@rine-kit/pubg-postgres';

await migratePubgDatabase(pool); // 幂等，可每次启动执行
const repo = new PostgresPubgRepository(pool, teamContext, conversation, {
  requireConversation: true,
  authorize: async (client, { tenantId, teamId, conversation }) => { /* 宿主检查，不通过就 throw */ },
});
```

## 测试

```bash
pnpm --filter @rine-kit/pubg-postgres test:pg   # 在一次性 pgvector 容器里跑，不碰任何真实库
```

没有 `PUBG_POSTGRES_TEST_DATABASE_URL`（或 `MEMORY_TEST_DATABASE_URL`）时测试自动跳过。
测试由 Gate 的 `postgres-repository` / `postgres-shard-scope` / `public-sync-queue` 原样移植。

## 与 Gate 的差异

| Gate | 本包 |
|------|------|
| 表名无前缀 | `pubg_*` |
| `tenants(platform='kook', bot_account_id, guild_id)` | `pubg_tenants(tenant_id)` |
| 会话列 `(platform, bot_account_id, user_id, channel_id)` | `(actor_id, channel_id)` |
| 仓库内置 KOOK 会话/频道绑定/授权表校验 | 宿主传入 `authorize` 回调 |
| `public_sync_jobs`、`pubg_api_admission` | `pubg_sync_jobs`、`pubg_api_admission` |
| 31 个迁移 | 1 个压缩迁移（只含 PUBG 表；记忆表在 `agent-memory-postgres`） |
| 旧版"按分片回填"升级测试 | 不移植（新库无历史） |
