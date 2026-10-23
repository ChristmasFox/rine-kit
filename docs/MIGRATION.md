# 第一批迁移：来源、版本与双宿主接线

状态（2026-10-23）：**本地可交付，未发布 npm，未打 tag。** 包版本统一 `0.1.0`，npm scope 暂定 `@rine-kit/*`（需 Arthur 确认并注册该 scope，见「阻碍」）。

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

## 暂未迁移（第二批候选）

`pubg-intelligence`（含 `gate-api` / 归档 / 回填，需先梳理 Gate 残留）、`agent-memory-plugin`、`pubg-plugin`（均为 plugin-sdk 之上的薄适配，RINE 目前独占）、`agent-core`（Vercel AI SDK Agent，Lab 用 OpenClaw，不会双宿主复用）。

## 许可证与发布

- MIT（见根 `LICENSE`），各包 `license: MIT`。
- 开发期 `exports` 指向 `src/*.ts`（不需要先 build）；`publishConfig.exports` 指向 `dist`，`pnpm pack` / `pnpm publish` 自动替换。`workspace:*` 在打包时被替换为精确版本。
- 发布（需 Arthur 明示后才做）：改版本 → `pnpm check && pnpm build` → `pnpm -r publish --access public`。无发布门禁、无 changeset 流程。
- 本地验证：`pnpm pack:all` 把全部 tarball 打到 `.scratch/tarballs`。

## 本地验证结果（kit）

- `pnpm check:boundaries`：公共包不依赖 `@rine/*`、`@agent/*`、LiveKit、OpenClaw。
- `pnpm typecheck` 通过；`pnpm test` 全绿；`pnpm test:pg`（临时 pgvector 容器）16/16。
- 7 个 tarball 在空项目中可安装且全部入口（含 `pubg-domain/core`）可 import（验证 `dist`、`default-team.json`、`migrations` 均随包）。

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
