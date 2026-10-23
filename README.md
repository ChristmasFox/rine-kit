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

## License

MIT（见 [`LICENSE`](./LICENSE)）。若后续对开源边界有调整，由 Arthur 决定。

## 开发（M204）

- `~/rine-kit` — 只跟踪 `main`
- `~/rine-kit-claude` — Claude 工作树，`claude/active`
- zellij 会话：`kit-claude`（布局 `~/.config/amadeus/zellij-layouts/kit-claude.kdl`）

详见 [`AGENTS.md`](./AGENTS.md)。
