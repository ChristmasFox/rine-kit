# PUBG Domain

PUBG 的平台无关 Domain：官方 PUBG API client、SQLite match/Telemetry store、确定性查询/比较、时间边界、review facts、证据引用和一次性迁移所需的数据结构。OpenClaw plugin 只调用这里的显式 service；本包不依赖 OpenClaw、LangBot、Mastra、Telegram、n8n 或任何 HTTP gateway。

`config/default-team.json` 是**完全虚构、不具备真实查询能力的 fixture**，不再包含真实 PUBG Account ID。生产插件要求显式的 `PUBG_TEAM_CONFIG_FILE`，从仓库外加载队伍配置；未配置将 fail closed。

初始化自己的小队（根据官方昵称解析官方 PUBG Account ID，默认仅写入 Git 忽略的 `.local/`）：

```sh
node scripts/init-pubg-team.mjs --players PlayerOne,PlayerTwo --platform steam --api-key-file .local/pubg-api-key
node --test scripts/test-init-pubg-team.mjs
```

详见 [Community PUBG Setup](../../docs/COMMUNITY_PUBG_SETUP.md)。API key、WhatsApp pairing 数据、真实队伍 ID 和其他凭据不得进入 Git。旧 Python V2 和 Runtime 只在 Git 历史中保留，不继续维护第二套实现。

## Tenant scope and repository ports

Query execution requires an explicit `TeamContext` containing the tenant ID,
team ID, and validated roster. The caller must resolve that scope before
entering the Domain; missing or mismatched scope fails closed. Public
authorization remains the application's responsibility.

`PubgDomainService` depends on the asynchronous `PubgRepositoryPort`. The
private OpenClaw adapter wraps its existing SQLite repository in
`SqlitePubgRepositoryAdapter`, pinned to the configured private scope. Public
PostgreSQL persistence is a separate adapter in `apps/pubg-saas`; it uses the
public database and application authorization, independently of private SQLite.
Both adapters must preserve the same `ToolEnvelope`, evidence, coverage,
partial/unknown and temporal contracts.

`tests/fixtures/shared-edge-cases.json` locks nine independent synthetic stat
expectations: KD/zero denominator, revives, squad rank, relative 06:00 periods,
day grouping, no matches, partial/unknown coverage and comparison ratios. Private
Domain tests run these without PostgreSQL or the public app. The public suite
then reads the same fixture through both adapters and compares whole deterministic
results. It also compares team damage/kick/punch/melee, derived evidence and
parser/feature cache versions, partial unavailable telemetry, successful zero,
and cache-only reads after reopening each independent store. These are offline
fixtures, not live independent deployment or restore acceptance.
