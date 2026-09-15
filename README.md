# toCodex2

ChatGPT 账号池管理系统（tosub2 改版）：代理池 + 三级号池（备用/主/废弃）+ 任务引擎 + **codex2api 管控**，单容器部署。

> 由 tosub2（sub2api 管理工具）改版而来，用于管理 [codex2api](../codex2api) 后端。
> 设计文档见 `docs/v2/`（架构、数据库、协议、API、前端、安全、部署、迁移、路线图全套规范），
> 改版的功能分析与接口对照见 [功能分析与实现方案.md](./功能分析与实现方案.md)。

## 功能总览

| 模块 | 能力 |
|---|---|
| 认证 | 首访设密 / HttpOnly Cookie 30 天滑动会话 / IP 限流（5 次锁 15 分钟，DB 持久）/ 改密全端登出 / CSRF 双保险 |
| 代理池 | 批量导入去重、一键测活（curl_cffi 过 CF 口径）、随机选路、失败降级本机直连 |
| 备用号池 | Outlook 四段导入（三重查重）、邮件初始化（初始余额 credits/25 + 封禁关键字）、单/批量加入主池 |
| 主号池 | 邮箱验证码自动登录（json-events 事件流驱动）、批量授权（refresh 优先失败转全登）、批量余额、批量上传 codex2api（串行+创建前二次校验的查重替换/最少绑定代理/---N 余额后缀） |
| 废弃号池 | 401/429/修复失败/登录封禁/手动废弃五类原因，支持移回主池；展示**加入备用池时间 / 加入主号池时间 / 已用额度 / 废弃时的代理 IP / 封号时的 Codex 指纹收敛**（见下） |
| 任务中心 | 队列/并发调度、人工内联输入（验证码/密码/手机号）、增量日志、取消/重试、代理风控自动重启、断点续跑、重启恢复 |
| codex2api | 连接配置加密存储、监控巡检（分类正则可配）、自动重登修复、自动补号 |
| 安全 | 凭据/token/代理 URL AES-256-GCM 入库、日志脱敏、敏感字段只写不读 |

## 与 tosub2 的关键差异（对接 codex2api）

- **认证**：上游管理接口用 `X-Admin-Key`（= codex2api 的 `ADMIN_SECRET`），路由前缀 `/api/admin/*`
- **代理**：codex2api 代理是 **URL 实体**，账号直接绑 `proxy_url`；「一键换 IP」按 URL 匹配/改绑/删除，改绑存在失败组时保留旧代理（删除即解绑，防止账号裸奔）
- **上传**：创建只带 `refresh_token`（邮箱由 codex2api 后台刷新回填，本地靠 `oauth---<邮箱>---N` 命名兜底建索引）；
  指纹收敛/基础并发/调度偏置/自动暂停在创建后经 scheduler PATCH 补写；`skip_refresh` 默认开（防批量上传打爆上游刷新）
- **替换凭据**：codex2api 无更新凭据接口，重登后 RT 轮换只能**先建新（沿用原名/代理/分组）→ 再删旧**
- **状态语义**：巡检按 codex2api 运行时状态分类（`error` 修复 / `rate_limited`·`usage_exhausted` 按 5h/7d 重置时间废弃 / `unauthorized` 走封禁邮件辅证）
- **用量口径**：累计消费取 `/api/admin/accounts/:id/usage?days=0` 的 `total_account_billed`
- **并发/优先级**：`base_concurrency_override`（每号并发）与 `score_bias_override`（-200~200 调度偏置，余额分档默认 +40/+20/+30/+10）

## 废弃号池的「已用额度」

废弃号池的「已用额度」与「主号池预估剩余余额」**同源**：取 codex2api 管理端账号的累计用量
（`total_account_billed`，`days=0` 全部历史）。

- **账号被废弃的当下自动抓取一次并落库**——codex2api 只保留账号当前累计用量，不提供历史时点查询，
  错过此刻就只能拿到「当前值」。
- 事后可用工具栏的**「同步远端用量」**按当前筛选批量刷新（默认跳过 24 小时内已同步的账号，
  显式全量重算由前端 `force` 触发）。列上的 tooltip 会标注同步时间与取值来源。
- 远端账号已被删除时无法取数，界面会区分「未同步」（待办）与「codex2api 中已无此账号」（确定事实）。

「加入备用号池时间」取 `COALESCE(imported_at, created_at)`；「加入主号池时间」取首次
`join_succeeded` 审计事件时间，没有该事件的账号（直入主池/收编/手动添加）回退 `created_at`
——与「按加入号池时间排序」共用同一口径（`server/lib/upload-order.js`）。

## 废弃号池的「代理 IP」（封号归因）

废弃池列表的「代理 IP」列显示**废弃那一刻**这个号走的出口代理：代理 label（codex2api 代理名）
+ 认证账号（proxy_url 里的 username）。同一个代理上接连死掉一批号，就是该 IP 被拉黑的信号。

- **只在废弃瞬间取一次**并落库（`accounts.discard_proxy_*`，迁移 `0011_discard_proxy.sql`）。
  远端绑定会被「一键更换代理 IP」改绑、旧代理随后被删除，号废弃后也可能被清理 ——
  事后再查只能得到「现在绑的是哪条」，与废弃当时的出口无关。
- 取值顺序：巡检手里的远端账号对象（废弃当时真实绑定，proxy_url 直读）→ 单账号接口 → 服务端 search 邮箱查找；
  远端没有这个号时退回**本机 tocodex2 代理**（该号最后一次任务的 `proxy_id` → 备注 + URL 里的认证账号）。
  登录类废弃的号多数没上过远端，这条兜底是唯一能拿到的出口线索。
- 取不到就显示 `—`，**不反推成「直连」**；老数据（本列上线前废弃的号）一律为空。
- 搜索框在废弃池同时匹配邮箱 / 代理名 / 认证账号，可直接按 IP 反查；表头「代理 IP」可排序（空值沉底）。

## 废弃号池的「Codex 指纹收敛」（封号归因）

废弃池列表的「Codex 指纹收敛」列显示**被封禁那一刻**这个号在 codex2api 侧的收敛档位
（账号平铺字段 `codex_fingerprint_mode`）：`关闭（透传）` / `仅设备` / `设备+会话` / `完全收敛`。
和「代理 IP」同一个用途 —— 同一档收敛下接连死掉一批号，就是该档位可疑的信号。

- **只在废弃瞬间取一次**并落库（`accounts.discard_codex_fingerprint_mode / _at`，迁移 `0012_discard_codex_fingerprint.sql`）。
- 档位只存在远端，本地库没有第二份：巡检手里的远端账号对象 → 单账号接口 → 邮箱查找。
  与出口代理**共用同一次远端解析**（两者在同一个账号对象上），不会把同一个号查两遍。
- codex2api 对 codex 渠道账号恒下发已归一的档位，`off` 是**确定**的结论；只有压根读不到
  （从未上传过远端 / 远端账号已删除）才显示 `—`，**不代填成 off**。
- 表头可排序，且**按收敛强度**排（透传 → 仅设备 → 设备+会话 → 完全收敛；倒排即把最可疑的完全收敛放最前），
  不是字典序；读不到档位的号两个方向都沉底。老数据（本列上线前废弃的号）一律为空。

## 列表页交互约定

- **筛选/排序/分页写入 URL**：刷新、后退、复制链接都能还原当前视图。
- **跨页选择**：勾选在翻页后保留；表头勾选框支持半选态；「选中全部 N 条」会从后端取回全部
  id 再按各接口的 `maxItems` 自动分片提交（上限集中在 `web/src/lib/batch.ts`）。
- **批量结果汇总**：成功/跳过/失败分区展示，可从结果里只重试失败项。
- **搜索框**统一 250ms 防抖，按 `/` 聚焦；`Alt+1..9` 跳转页面，`g` 后接字母走序列跳转。
- 列表按需轮询，**仅首次加载显示骨架**，后台刷新只在右上角转圈，不再整表闪烁。

## Outlook 原生取件

邮箱验证码、备用号池余额初始化和封禁邮件检查均直接访问微软官方接口：先通过
`login.microsoftonline.com/consumers/oauth2/v2.0/token` 换取访问令牌，再从
`outlook.office.com/api/v2.0/me/messages` 读取邮件。

沿用已导入的 Outlook `client_id` 和 `refresh_token`，邮箱密码不参与取件请求。授权范围与参考取件项目一致，
为 Outlook `IMAP.AccessAsUser.All`、`Mail.ReadWrite` 和 `offline_access`。登录收码读取最近 5 封，
余额和封禁检查默认读取最近 10 封。

## 快速开始

### Docker（推荐）

```bash
mkdir -p data && sudo chown 1000:1000 data   # volume 属主与容器内 node 用户一致
echo 'TOCODEX2_SECRET_KEY='"$(openssl rand -base64 32)" > .env
docker compose up -d
# 打开 http://127.0.0.1:2026 → 首访设置密码 → 登录
```

公网部署**必须**前置 Nginx/Caddy 做 HTTPS（反代示例见 docs/v2/08 §4）；compose 默认只绑 127.0.0.1。
默认端口 **2026**（tosub2 占 1999，两套控制台可同机并存）。

### 裸机开发

```bash
npm install
python3 -m pip install -r requirements.txt   # curl_cffi（TLS 指纹）
npm run build                                # 前端 → server/web-dist
npm start                                    # http://127.0.0.1:2026

# 前后端分离开发
npm run dev:web                              # vite :5173，/api 代理到 :2026
```

Windows 下 `better-sqlite3` 需预编译产物（npm 自动下载）；源码编译需 VS Build Tools。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `TOCODEX2_DATA_DIR` | `./data` | SQLite/密钥/日志/断点/产物根目录 |
| `TOCODEX2_PORT` / `TOCODEX2_HOST` | 2026 / 127.0.0.1 | 监听 |
| `TOCODEX2_CONSOLE_PASSWORD` | - | 首次密码种子（入库后不再生效） |
| `TOCODEX2_SECRET_KEY` | 自动生成 `data/secret.key` | 加密主密钥（建议显式提供） |
| `TOCODEX2_FORCE_SECURE_COOKIE` | - | `1` 强制 Cookie Secure |
| `TOCODEX2_PYTHON` / `TOCODEX2_TLS_PROFILE` / `TOCODEX2_LOG_LEVEL` | 自动 / - / info | 调试用 |

### codex2api 侧前置条件

1. codex2api 已配置 `ADMIN_SECRET`（未配置时其管理接口 fail-closed，可访问 `/admin/` 完成首次初始化）；
2. tocodex2「Codex2API」页填后端地址（如 `http://127.0.0.1:8080`）与管理密钥（= ADMIN_SECRET），点「测试连接」；
3. 建议先在 codex2api 系统设置里确认「新账号默认指纹收敛档位」的预期值（tocodex2 上传默认 off，
   需要收敛时在上传默认里显式选择，会在创建后逐号补写）。

## 备份与恢复

```bash
node scripts/backup.mjs /path/to/backup-dir --with-secret
# 恢复：停容器 → data/ 换回备份内容 → 起容器
```

## 从 tosub2 迁移

tocodex2 是独立安装（独立 data 目录与端口）。tosub2 的账号导出文件（`type: tosub2-accounts`）
可直接导入备用/主号池；sub2api 后端的账号导出文件（accounts 数组格式）同样支持导入。

## 测试

```bash
npm test          # server 单测 + 引擎集成测试（mock 子进程）
npm run check     # 语法检查
```

## 目录结构

```
tocodex2/
├── server/               # Fastify 后端
│   ├── core/             # v1 协议复用（登录/Sentinel/TLS 指纹/取件/接码，含 --json-events 改造）
│   ├── lib/              # db/crypto/config/settings/sanitize/totp
│   ├── migrations/       # SQLite 迁移（PRAGMA user_version）
│   └── modules/          # auth proxies accounts jobs codex2api team settings dashboard static
├── web/                  # React 19 + Vite + TanStack Router/Query + Tailwind4 前端
├── scripts/              # backup / dedupe-remote-accounts
├── data/                 # 运行数据（DB/密钥/日志/断点/产物）
└── docs/v2/              # 设计文档
```

## 许可

MIT
