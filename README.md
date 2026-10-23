# rine-kit

**开放核心 / Open Core** — 供 RINE（私有商业产品）与 Lab（开源 OpenClaw 实验系统）共同消费的可移植能力库。

## 定位

| 仓库 | 角色 |
|------|------|
| **rine-kit**（本仓库） | 开放核心：Plugin SDK、Memory、PUBG Domain、可移植 Agent 能力 |
| **RINE** | 私有商业产品：Desktop / API / LiveKit / Agent Host / 身份房间权限 |
| **Lab（amadeus-home）** | 开源个人实验：OpenClaw、WhatsApp、KOOK 等 |
| **Gate** | 冻结的历史源码来源，不再进入运行架构 |

本仓库是公共能力的**唯一源码来源**。原则是 **Extract Don't Rewrite**：从 RINE / Lab / Gate 迁移已验证实现，而不是重写等价逻辑。

## 包（0.1.0，未发布）

| 包 | 内容 |
|----|------|
| `@rine-kit/plugin-sdk` | 宿主无关的插件契约 |
| `@rine-kit/agent-memory` / `-postgres` / `-ai-sdk` | 记忆引擎 / Postgres+pgvector 存储 / Vercel AI SDK 适配 |
| `@rine-kit/presentation` | 回复展示契约 |
| `@rine-kit/pubg-domain` / `-tools` / `-intelligence` | PUBG Domain / 宿主无关工具目录 / Telemetry 分析 |
| `@rine-kit/agent-memory-plugin` / `pubg-plugin` | 记忆、PUBG 工具的 plugin-sdk 适配 |
| `@rine-kit/agent-core` | Vercel AI SDK 推理循环（RINE 用，Lab/OpenClaw 不用） |

来源、迁移范围与双宿主接线见 [`docs/MIGRATION.md`](./docs/MIGRATION.md)。常用命令：`pnpm check`（边界+类型+测试）、`pnpm test:pg`（需 Docker）、`pnpm pack:all`。

## License

MIT（见 [`LICENSE`](./LICENSE)）。若后续对开源边界有调整，由 Arthur 决定。

## 开发（M204）

- `~/rine-kit` — 只跟踪 `main`
- `~/rine-kit-claude` — Claude 工作树，`claude/active`
- zellij 会话：`kit-claude`（布局 `~/.config/amadeus/zellij-layouts/kit-claude.kdl`）

详见 [`AGENTS.md`](./AGENTS.md)。
