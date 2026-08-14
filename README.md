# session-teleport

DeepSeek Harness 多设备 Session 接力插件。PostgreSQL 是唯一在线权威；同一时间只有一台设备持有写入凭据，移交后旧凭据立即被 `writer_epoch` 拒绝。

这是独立插件仓库，只分发 BSD-3-Clause 许可下的 Session Teleport 代码。
DSH peer packages 是外部依赖，保留各自许可，不在本仓库中复制、镜像或重新授权。
本包保留 `private: true`，避免本地发布演练误触 npm 发布；受支持的插件源是
`https://github.com/omdsh-dev/session-teleport`，安装时必须固定到完整 commit。

当前适配器使用 npm next 包做严格编译基线：`@deepseek-ai/cordis@4.0.1-rc.4`，
以及 `@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-session-persistence`、
`@deepseek-ai/dsh-session-persistence-jsonl` 的 `0.1.0-rc.6`。这些精确版本只用于
开发和验证；安装时仍由目标 DSH 环境按 `peerDependencies` 提供兼容版本。

## 能做什么

- 原样保存 JSON event envelope，包括扩展字段。
- 在单个事务中校验 writer、revision、next seq 和连续事件序号。
- 通过 idempotency key 与请求摘要安全重认“已提交但响应丢失”的重试。
- 生成一次性、限时 handoff code；接管后旧 writer token 被 fencing。
- 旧设备丢失时可由独立管理员凭据执行显式恢复接管，并审计每次 writer 变化。
- 可对既有 Session 做无写入 dry-run、单事务导入和受约束的回滚切换。
- 可从旧 DSH Profile 临时挂载只读 overlay，经 `inspect()` 抓取 Session，
  不必手写 TypeScript，也不解析 JSONL/SQLite 物理文件。
- 提供计划优先的 `install / upgrade / uninstall / doctor` 生命周期工具；
  只接受完整 commit pin，结构校验失败会恢复旧依赖。
- 提供一致快照、增量读取与 SSE 观察端点。
- 提供 DSH `PersistenceBackend` adapter 和 profile bundle patch。
- 将每个 Session 的 writer credential 保存为本机 0600 原子文件。
- 在非 loopback 监听时强制配置服务 Bearer token。

## 架构

```text
DSH device A ─┐
DSH device B ─┼─ HTTP/SSE Teleport service ─ PostgreSQL
observer     ─┘
```

客户端不直接连接 PostgreSQL。PostgreSQL 负责事务、行锁、CAS、writer fencing 和幂等记录；SSE 只是通知通道，客户端仍从权威表读取数据。

## 安装插件

首次安装从目标 commit 的本地 checkout 运行生命周期工具。默认只输出计划：

```bash
node dist/plugin-cli.js install --profile web --revision <full-commit-sha>
node dist/plugin-cli.js install --profile web --revision <full-commit-sha> \
  --apply --profile-stopped --cutover-safe
```

目标环境需要通过其正常、受支持的软件源解析匹配版本的 `@deepseek-ai` peer
packages。本仓库不分发这些依赖，也不要求把软件源配置或访问凭据放入仓库。

为运行该 profile 的每台设备配置：

```bash
export DSH_TELEPORT_ENABLE=1
export DSH_TELEPORT_URL=https://teleport.example.com
export DSH_TELEPORT_API_TOKEN=a-long-random-service-token
export DSH_TELEPORT_DEVICE_ID=office-mac
# 可选：启动健康检查超时，默认 5000 毫秒
export DSH_TELEPORT_HEALTH_TIMEOUT_MS=5000
```

仅安装 bundle 不会切换 Session authority：默认仍使用 RC.6 自带 JSONL，Teleport
adapter 保持禁用。先启动 Teleport 服务并验证 `/health`，再停止 profile、设置
`DSH_TELEPORT_ENABLE=1` 并重启，才会关闭 JSONL、启用 Teleport。显式启用后如果
服务不可达，profile 会拒绝启动，不会静默回退到另一份权威存储。

启用或停用会切换 Session authority，升级也会替换 profile 依赖。请先让正在写入的
turn 完成并停止对应 profile，再重启；不要把它当成对运行中 Session 无影响的热替换。
生命周期工具不会删除 PostgreSQL 数据或本机 writer 凭据。完整步骤见
[插件生命周期](docs/PLUGIN_LIFECYCLE.md) 和 [DSH 接入说明](docs/DSH_INTEGRATION.md)。

## 运行服务

需要 Node.js 22.19+ 和 PostgreSQL：

```bash
export NPM_TOKEN
pnpm install --frozen-lockfile --ignore-scripts
pnpm build

cp .env.example .env
set -a && source .env && set +a
pnpm start
```

服务默认监听 `127.0.0.1:43127`，启动时自动创建所需数据库表。从插件包安装后也可直接运行 `dsh-teleport-server`。

除 `/health` 外，请求需要：

```text
Authorization: Bearer $TELEPORT_API_TOKEN
```

管理员恢复还需要与普通 API token 不同的 `TELEPORT_ADMIN_TOKEN`。

主要端点：

- `GET /v1/sessions`
- `POST /v1/sessions`
- `POST /v1/sessions/materialize`
- `GET /v1/sessions/:id/head`
- `GET /v1/sessions/:id?after=-1`
- `GET /v1/sessions/:id/watch?after=-1`
- `POST /v1/sessions/:id/append`
- `POST /v1/sessions/:id/handoffs`
- `POST /v1/handoffs/:code/accept`
- `POST /v1/admin/sessions/:id/recover-writer`
- `GET /v1/admin/sessions/:id/writer-audit`
- `POST /v1/admin/sessions/:id/rollback-import`

## 换机

先让旧设备上的当前 turn 完成，然后生成一次性码：

```bash
pnpm device create-handoff <session-id>
```

在新设备上设置不同的 `DSH_TELEPORT_DEVICE_ID`，再接受：

```bash
pnpm device accept-handoff <one-time-code>
```

旧设备丢失且无法生成移交码时，在目标设备上配置管理员凭据并执行显式恢复：

```bash
export DSH_TELEPORT_ADMIN_TOKEN=a-different-long-admin-token
export DSH_TELEPORT_ADMIN_ACTOR=operator-name
pnpm admin recover-writer <session-id> "lost device"
pnpm admin writer-audit <session-id>
```

恢复操作会原子增加 `writer_epoch`、保存新凭据并记录原因；它不是自动 lease，不会因短暂断网自行驱逐 writer。

## 导入既有 Session

先让旧 writer 完成当前 turn、flush 并停止对应 Profile。迁移工具会临时启动
这个 Profile，挂载一次性只读 overlay，并把一致 `inspect()` 结果写成 `0600`
bundle；它不修改旧 Profile 配置或旧存储，也不会覆盖已有输出文件：

```bash
dsh-teleport-import capture <source-profile> <session-id> <session.session-import.json>
```

然后依次运行：

```bash
dsh-teleport-import dry-run <session.session-import.json>
dsh-teleport-import apply <session.session-import.json>
```

导入不会修改旧存储。若切换后的只读 smoke check 失败，且 Teleport 尚未发生
新 append、handoff 或 recovery，可使用管理员令牌执行：

```bash
dsh-teleport-import rollback <session-id> "cutover smoke check failed"
```

一旦目标 head 或 writer epoch 前进，回滚会明确拒绝，避免切回旧前缀导致历史
丢失。完整边界见 [导入与可回滚切换](docs/IMPORT_AND_CUTOVER.md)。

## 开发与验证

```bash
export NPM_TOKEN
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm audit --prod
```

只读 npm 令牌仅通过进程环境提供；仓库 `.npmrc` 只保存 `${NPM_TOKEN}` 占位符，
发布包检查会拒绝把 `.npmrc` 打进产物。

仓库内的通用测试覆盖 authority 的 CAS/fencing/handoff/idempotency、HTTP API、schema 与 credential file。更多说明见 [测试边界](docs/TESTING.md)。

模拟测试不能替代物理双机、真实网络和 PostgreSQL 故障演练。候选版本应按
[真实设备验收](docs/REAL_DEVICE_ACCEPTANCE.md) 执行两机测试。

## 正确性边界

- 当前版本是单写者接力与显式恢复，不是任意多写者自动合并。
- 如果未来支持离线多写者，推荐把冲突保存为显式 branch，再 fast-forward 或人工
  merge；不把两条对话和工具副作用自动穿插。设计边界见
  [多写者分支策略](docs/MULTIWRITER.md)。
- 并发 append 只有一个能推进 revision；其他请求明确冲突，不会静默拼接历史。
- 本地 SQLite 可作为未来离线缓存；NAS/S3/MinIO 可作为未来快照或冷备，但不参与在线 head 竞争。
- 多服务副本需要跨实例通知机制；通知只用于唤醒，不能代替 PostgreSQL 权威读取。
- 尚未认证物理多主机网络、TLS/反向代理、PostgreSQL HA、长时间分区、PITR 恢复和持续负载。
- 不直接解析或改写 JSONL/SQLite 物理文件；导入使用原后端读出的一致 portable snapshot。

事件列使用 PostgreSQL `JSON` 而不是 `JSONB`，以保留 event envelope 的序列化键顺序和无损往返。schema 会拒绝无法证明无损的旧格式迁移，避免静默改写历史。

## License

BSD-3-Clause
