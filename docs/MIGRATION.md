# 迁移记录：来源、版本与双宿主接线（第一批 + 第二批）

状态（2026-10-23）：第一批已在 origin/main（`3cc5bdf`）；第二批在 `claude/active`，待确认合并。**未发布 npm，未打 tag。** 包版本统一 `0.1.0`，npm scope 暂定 `@rine-kit/*`（需 Arthur 确认并注册该 scope，见「阻碍」）。

## 包与来源（Extract Don't Rewrite）

源码逐文件取自 RINE `main` @ `104a687`，由 RINE 当时从 Lab / Gate 原样提取；仅做：包名 `@rine/*` → `@rine-kit/*`、`private`/`license` 元数据、`plugin-sdk` 补 `tsconfig.build.json` 与发布入口。算法与测试未改。

| 包 | 原始来源 | 说明 |
|----|----------|------|
| `@rine-kit/plugin-sdk` | RINE `packages/plugin-sdk` | 宿主无关的工具 / prompt 插件契约 |
| `@rine-kit/agent-memory` | Lab `packages/agent-memory`（原 Gate）+ RINE 增补 `context/`（预算 / 滚动检查点，原 Gate） | 记忆引擎核心，仅依赖 `node:crypto` |
| `@rine-kit/agent-memory-postgres` | Gate Postgres 存储 / 索引 / Consolidation，经 RINE | pgvector 迁移随包发布 |
| `@rine-kit/agent-memory-ai-sdk` | Gate Embedding / Planner，经 RINE | Vercel AI SDK 适配（OpenClaw 宿主不必引入） |
| `@rine-kit/presentation` | Lab `packages/presentation` | 回复展示契约 / 渲染 |
| `@rine-kit/pubg-domain` | Lab `packages/pubg-domain` | PUBG API、统计、时间、Telemetry、review；含 `./core` 入口 |
| `@rine-kit/pubg-tools` | RINE 新增的宿主无关工具目录（基于 Lab Domain） | |

与 Lab 现有包的差异（prettier 规范化后比对）：`presentation` 完全一致；`pubg-domain` 仅 fixture 格式差异；`agent-memory` 仅多出 `context/` 与 `scheduler.ts` 一处 `let runId` 的类型声明。结论：kit 是 Lab 的超集，Lab 可无损切换。

## 第二批（11 个包全部在 kit）

同样逐文件取自 RINE `main@104a687`，源码与测试不改；仅改包名、元数据与 tsconfig。

| 包 | 来源 | 说明 |
|----|------|------|
| `@rine-kit/pubg-intelligence` | Lab `packages/pubg-intelligence`（与 RINE 副本格式规范化后零差异，Lab 最近提交 `b730c370`） | 战斗/节奏/战术/风格/高光/赛局叙事/研究/评测/原始 Telemetry 归档；入口 `.`、`./archive`、`./backfill` |
| `@rine-kit/agent-memory-plugin` | RINE | agent-memory 接到 plugin-sdk 宿主：remember/correct/forget 工具 + recall/observe hook |
| `@rine-kit/pubg-plugin` | RINE | pubg-tools 目录包装成 plugin-sdk 插件（OpenClaw 宿主继续用自己的薄适配，不依赖本包） |
| `@rine-kit/agent-core` | RINE | Vercel AI SDK 推理循环（OpenAI 兼容端点、插件工具、文本/语音共用 turn）。Lab 不使用，也不要求 Lab 采用 AI SDK |

### Gate 残留处理
- **不迁入** `src/gate-api.ts`、`src/gate.ts`、`tests/gate-api.test.ts` 及 `./gate` 导出（`GATE_PUBG_INTELLIGENCE_*`、`summarizeGateCachedFeatures`）。理由：只有冻结的 Gate（Lab `apps/pubg-saas`）消费，RINE 无消费者；Gate 只作历史源码，不进公共包。该函数本身是只依赖 `pubg-domain` 类型的纯函数，没有 Gate 运行时依赖，所以处理方式是**把源码留在 Gate 侧**：切换时拷到 `apps/pubg-saas/src/application/gate-intelligence-api.ts`（试验已验证）。
- kit 内其余模块无 Gate 引用（`promotionGate` 是评测指标名，与 Gate 产品无关）。`scripts/` 的两个 CLI 用环境变量取路径，不随包发布。
- `pubg-intelligence` 测试数 106 → 103（少 3 个 gate-api 测试，随源码留在 Gate 侧）。
- `agent-core` / `agent-memory-plugin` 沿用 RINE 的类型检查严格度（未开 `exactOptionalPropertyTypes`），避免为此改源码。

### 第二批双宿主注意点
RINE：删除全部 11 个本地包（只剩 `apps/*` 与 `shared`）；全仓类型检查通过，测试全绿（desktop 84、api 102、agent 93）。除第一批已列事项外无新增。
Lab：除第一批事项外：
- `apps/pubg-saas` 把 `gate-api` 与其测试留在本地（见上），`@agent/pubg-intelligence/gate` 引用改为相对路径；`public-domain-runtime-boundary` 测试里的动态 import 只保留 `@rine-kit/pubg-domain/core`。
- `pubg-intelligence-lab` 的测试读了 `packages/pubg-intelligence/tests/highlight-fixture.ts`，该 fixture 复制到 `apps/pubg-intelligence-lab/tests/`。
- 删除 `packages/pubg-intelligence`；`plugins/pubg`、`pubg-intelligence-lab` 改依赖 `@rine-kit/pubg-intelligence`。
- 结果：`build`、各 `typecheck`、`test:pubg`、`test:amadeus` 通过；`pubg-saas` 207 测试 0 失败；`pubg-intelligence-lab` 仅剩基线上就失败的 `public-access`（需先 build client）。

## 许可证与发布

- MIT（见根 `LICENSE`），各包 `license: MIT`。
- 开发期 `exports` 指向 `src/*.ts`（不需要先 build）；`publishConfig.exports` 指向 `dist`，`pnpm pack` / `pnpm publish` 自动替换。`workspace:*` 在打包时被替换为精确版本。
- 发布（需 Arthur 明示后才做）：改版本 → `pnpm check && pnpm build` → `pnpm -r publish --access public`。无发布门禁、无 changeset 流程。
- 本地验证：`pnpm pack:all` 把全部 tarball 打到 `.scratch/tarballs`。

## 本地验证结果（kit）

- `pnpm check:boundaries`：公共包不依赖 `@rine/*`、`@agent/*`、LiveKit、OpenClaw。
- `pnpm check`（边界 + 类型 + 测试）通过；`pnpm test:pg`（临时 pgvector 容器）postgres 16/16、memory-plugin 6/6。
- 全部 11 个 tarball 在空项目中可安装且全部入口（含 `pubg-domain/core`）可 import（验证 `dist`、`default-team.json`、`migrations` 均随包）。

## 双宿主接线证明

均在 **临时 worktree** 完成，未改 RINE / Lab 的任何正式分支。补丁存本机 `.scratch/patches/`（不入库）。试验时依赖用 pnpm `overrides` 指向本地 tarball；正式切换时改为 registry 上的 `0.1.0`。

### RINE（@ `104a687`）
删除 7 个本地包；全仓 `@rine/<包>` → `@rine-kit/<包>`，依赖 `workspace:*` → `0.1.0`。结果：全仓 `typecheck` 通过；`test` 全绿（desktop 84、api 102、agent 93（3 skip）、pubg-intelligence 106、agent-core 31、memory-plugin 6、pubg-plugin 1）。
切换时需同步处理：
- `pubg-intelligence/tsconfig.json` 原 `extends` 被删的 `pubg-domain/tsconfig.json`，改为内联选项。
- `pubg-plugin` 测试用相对路径读 `pubg-tools/tests/fixtures`，fixture 复制到 `pubg-plugin/tests/fixtures`。
- `eslint.config.js`、`docs/architecture.md`、根脚本 `test:memory` 里的包名 / 路径。

### Lab（amadeus-home，OpenClaw 保持不变）
删除 `packages/{agent-memory,presentation,pubg-domain}`；`plugins/pubg`（OpenClaw 适配器）、`plugins/amadeus`、`pubg-intelligence`、`pubg-intelligence-lab`、`product-radar`、`pubg-saas`（Gate，冻结）改用 `@rine-kit/*`；根脚本去掉对应 `--filter` 段。Lab 仍用 OpenClaw，不引入 Vercel AI SDK（`agent-memory-ai-sdk` 未被 Lab 依赖）。
结果（先跑 Lab 自己的 `pnpm build`）：`typecheck`、`typecheck:pubg-saas`、`typecheck:pubg-intelligence-lab` 通过；`test:pubg`、`test:amadeus` 全绿；`pubg-saas` 204 测试 0 失败（与基线一致）。
基线上本就失败、与本次无关：`check:architecture`、`pubg-intelligence-lab` 的 `public-access` 一项（需先 build client）。
切换时需同步处理：
- `scripts/check-architecture.mjs` / `test-check-architecture.mjs` 直接检查被删包的源码路径；这些规则应迁到 kit（`check:boundaries` 已覆盖依赖边界），Lab 侧改为检查 `node_modules/@rine-kit/*` 或删除。
- `pubg-saas` 两个 parity 测试读 `packages/pubg-domain/tests/fixtures`，fixture 复制到 `apps/pubg-saas/tests/fixtures`（Gate 已冻结，也可直接下线这两个测试）。
- `pubg-intelligence/tsconfig.json` 同 RINE，内联。
- 各 `Dockerfile` 原先 COPY 被删包目录，需改为从 registry 安装。
- README 里对 `packages/pubg-domain` 的链接。

## 阻碍 / 待 Arthur 决定

1. **npm scope**：`@rine-kit` 是否可用 / 注册；若换 scope，全局替换即可。
2. **GitHub 远端**：`ChristmasFox/rine-kit` 尚未推送本分支；未发布任何包，因此「RINE/Lab 已切换到 registry 版本」**尚未发生**，只证明了切换可行。
3. RINE / Lab 的正式切换（删除重复实现）需发布 `0.1.0` 之后进行，避免主干依赖一个不存在的包。

## 第三批（0.1.3）：Lab 的 PUBG 回复胶水

状态（2026-10-27）：`@rine-kit/pubg-reply` 新增；其余包升到 0.1.3。

| 包 | 来源 | 说明 |
|----|------|------|
| `@rine-kit/pubg-reply` | Lab `plugins/pubg/src/{index.ts 中的 jsonToolResult 及辅助函数, reply-guides.ts, evidence-guard.ts, query-share.ts}`、`plugins/amadeus/src/group-roster.ts`、`plugins/pubg/skills/pubg/SKILL.md` | 工具结果怎么交给模型与聊天：presentation / 聊天版 displayText / replyGuide / 🔗；Kurisu 示例与群语气锚点、称呼名册；PUBG 规则全文；裸战绩=全队护栏与外发证据检查。**原样移入**，只去掉 OpenClaw 的 `jsonResult` 包装，回复指南的示例可替换，类型处加了严格模式需要的 `??` |

证明：`packages/pubg-reply/tests/golden` 由 Lab 自己的 `jsonToolResult` 生成（`scripts/gen-golden-from-lab.ts`，只读 Lab），包内测试与之逐字节相同；`pubg-tools/scripts/compare-lab-schemas.ts` 证明八个工具的输入形状与描述和 Lab 一致。

其他：`pubg-plugin` 新增 `reply` / `rules` 选项（默认行为不变）；`agent-core` 新增 `replyStream`、`ToolRecord`、`noTools`；`pubg-postgres` 新增 `pubg_review_shares` 与 `PostgresReviewShareStore`；`pubg-postgres` 新增 SQLite↔PostgreSQL 工具级等价测试。

Lab 切换（另行处理，本轮未改 Lab）：`plugins/pubg` 的 `jsonToolResult` / `reply-guides` / `evidence-guard` / `query-share` / `amadeus` 的 `group-roster` 改为依赖 `@rine-kit/pubg-reply`，删除自己的副本；黄金测试已证明行为不变。

