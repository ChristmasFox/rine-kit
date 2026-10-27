# @rine-kit/pubg-sync

PUBG 数据同步：团队同步 worker、玩家名解析、官方 API 额度准入（限流）、出口代理配置、worker 指标/健康检查。
提取自 Gate 的 `pubg-saas`，逻辑、默认值与测试保持一致；表名换成 `@rine-kit/pubg-postgres` 的 `pubg_*`。

## 额度准入（限流）

`PostgresPublicPubgAdmission` 用数据库里 `pubg_api_admission` 的一行（`quota_scope='public-pubg'`）排队放行：
同一数据库的所有进程共用一个额度，默认每分钟 10 次、最长等待 8 秒；收到 429 或剩余额度为 0 时按响应头封锁到重置时间。
**同一个 PUBG API key 只能由使用同一个数据库的进程共用**，否则各自限流会叠加超限。

## 运行 worker

```bash
DATABASE_URL=postgres://... PUBLIC_PUBG_API_KEY=... node dist/worker-main.js --apply [--once]
```

不带 `--apply` 只打印提示（空跑）。未设置 `PUBLIC_SYNC_INTERVAL_MS` 时，调度与 Lab 的 `amadeus-pubg-telemetry-hourly` 相同：每小时第 5 分（`PUBLIC_SYNC_TIMEZONE` 默认 `Asia/Shanghai`，`PUBLIC_SYNC_HOURLY_MINUTE` 可改）刷新玩家列表，只拉本地没有的新比赛，并为新对局或到期重试对局取遥测（`maxMatches=500`、`maxFetches=20`、并发 2）。空闲时最多每分钟看一眼队列，所以新登记的小队不用等整点；这一眼不打 PUBG。设置 `PUBLIC_SYNC_INTERVAL_MS` 则改回固定间隔。

其余环境变量（均有默认值）：`PUBLIC_PUBG_REQUESTS_PER_MINUTE`、`PUBLIC_SYNC_MAX_MATCHES`、`PUBLIC_SYNC_MAX_TELEMETRY_FETCHES`、`PUBLIC_SYNC_TEAM_CONCURRENCY`、`PUBLIC_SYNC_LEASE_MS`、`PUBG_SAAS_WORKER_METRICS_PORT`、`PUBLIC_SYNC_HEALTH_PORT`（默认 8081）、`PUBLIC_SYNC_CATCHUP_MS`（每小时模式下遥测有积压时多久后再跑，默认 300000，0 关闭）。可选 `PUBLIC_TELEMETRY_ARCHIVE_DIR`：设置后，下载的原始遥测先落入该目录（必须在进程工作目录之外；`RawTelemetryArchive`，gzip、按 Match ID、校验 SHA-256）。提问侧要把同一个目录传给 `PubgDomainService` 的 `rawTelemetryArchive`。不设置则特征缓存未命中时仍向遥测 CDN 取原始文件。worker 启动时会自己执行 `migratePubgDatabase`（`@rine-kit/pubg-postgres`，幂等、带咨询锁），不依赖宿主 API 先迁移；宿主照常可以在自己启动时迁移。

## 测试

```bash
pnpm --filter @rine-kit/pubg-sync test:pg   # 一次性 pgvector 容器
```

## 没有提取的

- `egress-proxy.ts`（Gate 容器网络里的 CONNECT 出口代理及其测试）：属于 Gate 的部署形态，RINE 走本机代理即可。
