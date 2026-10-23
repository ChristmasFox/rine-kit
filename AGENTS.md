# AGENTS.md — rine-kit 协作规则

rine-kit 是 RINE（私有商业）与 Lab（开源 OpenClaw）共用的**开放核心** Monorepo。
公共能力的唯一源码来源；原则：**Extract Don't Rewrite**（迁移已验证实现，不重写等价逻辑）。

主机/网络/zellij 保活等公共设施见 `~/.config/amadeus/M204-HOST.md`。

## 分支、工作树与会话

| 工作树 | 分支 | 谁用 |
|--------|------|------|
| `~/rine-kit` | 只跟踪 `main` | 人 / Manager；不做功能开发 |
| `~/rine-kit-claude` | `claude/active` | Claude |
| `~/rine-kit-codex`（可选，按需再建） | `codex/active` | Codex |

- zellij 会话名：`kit-claude`
- 布局：`~/.config/amadeus/zellij-layouts/kit-claude.kdl`
- 两个工作树不能同时 checkout 同一分支；每个会话在自己的工作树里启动。
- **禁止 force-push `main`**。合并进 `main` 不等于发 npm。
- 合并前按仓库实际脚本通过类型检查 / lint / 测试（有则跑；脚手架阶段以能独立构建为准）。
- 提交信息用中文，说明改了什么、为什么、怎么验证。
- **Secrets 永不入库**（`.env*`、token、密钥等）。
- **不要自行 `npm publish` / 打正式 tag**，除非 Arthur 明确要求。
- 不要为保活用 expect / 0×0 / `TERM=dumb` 长期 attach（见 M204-HOST「zellij 保活」）。

## 架构边界

- **rine-kit**：Plugin SDK、可复用 Agent/Memory、PUBG Domain、工具目录、可移植 Adapter。
- **RINE 保留**：Desktop、API、LiveKit、Agent Host、身份、房间、权限、产品数据与私有商业逻辑。
- **Lab 保留 OpenClaw**；不能为了复用而切换到 Vercel AI SDK。
- **Gate** 只作历史源码来源，不继续开发。
- 公共包**不应**强依赖 RINE API、LiveKit 或 OpenClaw；这些留在宿主 Adapter 内。

## 本轮迁移原则

1. 审查 RINE 最新 `main` 与 Lab/Gate 源码，确认哪些公共模块已真正完成代码迁移。
2. 第一批优先：Plugin SDK、Memory Core、PUBG Domain。
3. 提取到本仓库时保留成熟算法与业务行为，清理对私有应用的依赖。
4. RINE 用版本化 npm 消费；Lab 用适合 OpenClaw 的 Adapter 消费同一份能力。
5. 双宿主验证通过后，删除已替代的重复实现——真实共享一份源码。

## 明确不做

- 不做插件市场、OAuth 应用平台、远程插件托管、微服务或复杂发布门禁。
- 不迁移 RINE 私有产品代码或 Git 历史到本仓库。
- 不因提取而重写 LiveKit、RINE API、OpenClaw Agent 或已有 PUBG 算法。
- 不把 Gate 恢复为活跃开发项目。
