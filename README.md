# kimi-code-feishu (TypeScript)

让 **Kimi Code CLI** 连上飞书机器人：在任何地方用手机给 Kimi Code 派任务、看实时进度、批准/拒绝权限请求。

这是 [kimi-code-feishu](https://github.com/) 的 TypeScript/npm 实现，与 Python 版**协议和配置完全兼容**（同一份 `~/.kimi-code-feishu/config.toml`、同一组 hook HTTP 接口），两版可互换使用。

```
┌─────────────┐   飞书长连接(WebSocket)   ┌──────────────────────────────┐   stdin/exit code   ┌─────────────┐
│  手机飞书    │ ◄──────────────────────► │        本桥接服务             │ ◄────────────────► │ Kimi Code   │
│  (消息/卡片) │                          │  FeishuChannel ⇄ Bridge      │    hooks           │ CLI(本机)   │
└─────────────┘                          │  HookServer(127.0.0.1:17771) │                      └─────────────┘
                                         │  KimiRunner(kimi -p 子进程)  │ ── 派任务/读进度 ──►
                                         └──────────────────────────────┘
```

- **无需公网 IP / 内网穿透**：飞书侧走 WebSocket 长连接（官方 `@larksuiteoapi/node-sdk`），hook 侧只监听 `127.0.0.1`
- **三条链路**：
  1. **派任务**：飞书发消息 → 本地 `kimi -p --output-format stream-json` 执行 → 结果回推
  2. **批权限**：`PreToolUse` hook → 飞书卡片（✅批准 / 🔁本会话允许 / ❌拒绝）→ 按你的点击放行或阻断
  3. **看进度**：`PostToolUse` / `Stop` 等 hook 事件实时推送（终端里手动跑的 kimi 会话也能监控）
- **审批等待用 Promise 实现**：卡片发出去 = 挂起一个 Promise，按钮回调来 resolve——Node 事件循环天然契合，无线程

---

## 一、安装

| 依赖 | 说明 |
|---|---|
| Node.js ≥ 18 | 用到全局 `fetch`、`AbortSignal.timeout` |
| Kimi Code CLI | 已安装并完成 `/login` |
| 飞书账号 | 能创建企业自建应用 |

```bash
npm install -g kimi-code-feishu        # 发布后
# 或从源码安装
npm install && npm run build && npm link
```

安装后得到 `kimi-code-feishu` 命令。

## 二、创建飞书应用（约 1 分钟）

```bash
kimi-code-feishu onboard
```

onboard 提供两种接入方式，启动后按提示选择：

### 方式 1：扫码即创（推荐）

终端显示二维码，用**飞书手机 App 扫码**并在官方确认页点确认即可——飞书服务端自动创建好带机器人能力和消息权限的应用，`app_id` / `app_secret` 和你的 `open_id`（自动加入 `allowed_user_ids`）会直接写入配置，无需手动创建应用。

> 原理：飞书官方账号体系的 Device-Flow 应用注册协议（与官方开源 [larksuite/cli](https://github.com/larksuite/cli) 相同），全程匿名调用、无需公网回调，配置写入后仍需手动 `run` 启动桥。
> 扫码创建用的是官方预置模板（PersonalAgent），审批卡片所需的 `card.action.trigger` 等配置已包含；如后续需要额外权限（文档、日历等），仍需到开发者后台补配。
> 应用名默认为官方模板名（如「CLI 助手」）：扫码时在**手机确认页上可以直接修改**；事后改名请到开发者后台「凭证与基础信息」页（`https://open.feishu.cn/app/<appId>/baseinfo`），需创建新版本并发布才生效。

### 方式 2：手动输入已有应用的凭证

在 onboard 菜单选 `2`，粘贴已有的 **App ID** / **App Secret**（open_id 可留空，之后私聊机器人发 `/id` 获取再补填）。适合已经有配置好的应用、或需要自定义权限模板的场景。也可用 `kimi-code-feishu init` 生成配置模板后手动编辑。

手动创建应用的步骤：

1. [飞书开放平台](https://open.feishu.cn/app) → **创建企业自建应用**（如「Kimi 遥控器」）。
2. **添加应用能力** → 机器人。
3. **权限管理** 开通：`im:message`、`im:message:send_as_bot`、`im:message:readonly`。
4. **事件订阅**：
   - 接收方式选 **使用长连接接收事件**（不需要公网 IP 的关键）；
   - 添加事件 **`im.message.receive_v1`**；
   - 添加回调 **`card.action.trigger`**（审批按钮依赖它）。
5. **版本管理与发布** → 创建版本并发布。
6. **凭证与基础信息** 页复制 **App ID** / **App Secret**。

## 三、配置与启动

```bash
kimi-code-feishu onboard               # 扫码创建应用并自动写入配置（推荐，见上一节）
# 或手动方式：kimi-code-feishu init 生成 ~/.kimi-code-feishu/config.toml 后自行填入凭证
kimi-code-feishu run                   # 启动桥（保持运行）
# 手动方式还需：手机飞书私聊机器人发 /id → 把返回的 ou_xxx 填入 allowed_user_ids → 重启桥

# 另一个终端：把 hooks 写入 Kimi CLI 配置（自动探测 ~/.kimi 或 ~/.kimi-code，自动备份）
kimi-code-feishu install
```

`install` 写入的 hook 命令形如：

```toml
[[hooks]]
event = "PreToolUse"
command = " /usr/bin/node /path/to/dist/hook.js pre_tool_use"
timeout = 180
```

> 重启正在运行的 kimi 会话后生效；CLI 内 `/hooks` 可确认。TS 版不需要 PYTHONPATH，hook 用绝对路径直接调用。

后台常驻：

```bash
nohup kimi-code-feishu run > ~/.kimi-code-feishu/bridge.log 2>&1 &
# 或 pm2 / systemd，任选
```

## 四、使用方法

### 飞书里（手机/电脑均可）

| 输入 | 作用 |
|---|---|
| `帮我跑一下测试并修复失败用例` | 直接派任务（流式回报，危险操作弹审批卡片） |
| `/bind /home/me/projects/foo` | 绑定本聊天的工作目录 |
| `/new` / `/stop` / `/status` / `/id` / `/help` | 会话管理 / 终止 / 状态 / 查 open_id / 帮助 |

### 工作目录绑定（/bind）

一个聊天 ≈ 一个项目的远程遥控窗口。`/bind` 决定三件事：

1. **任务执行位置**：派任务时桥以绑定目录为 cwd 拉起 `kimi -p`，AI 读写文件、跑命令都在这个目录下；不绑则用配置里的默认 `work_dir`。
2. **会话续接锚点**：默认用 `kimi -c` 续接该目录的最近一次会话；换绑目录即开启另一条会话线，上下文互不串。
3. **终端会话路由**：终端里手动跑 `kimi` 时产生的审批卡片和进度推送，按会话 cwd 匹配到绑了同目录的聊天。

不同聊天（多个私聊/群）可各绑各的项目，互不影响；`/bind` 会同时重置该聊天的会话（等同 `/new`）。

### 审批卡片

- **✅ 批准**：放行这一次；**🔁 本会话允许**：同会话同类工具自动放行；**❌ 拒绝**：阻断并把原因反馈给模型
- 超时未点（默认 150s）按 `on_timeout` 处理，默认拒绝
- 不弹卡片的情况：只读工具（`auto_allow_tools`）直接放行；命中 `auto_deny_patterns`（如 `rm -rf /`）直接拒绝

### 监控终端会话

终端里跑 `kimi --yolo`，审批闸门即完全交给飞书卡片，出门在外也能远程点头。

## 五、安全设计

- **白名单**：仅 `allowed_user_ids` 中的 open_id 能发指令、点卡片；其他人点击被忽略并记日志
- **不出本机**：hook 服务只听 `127.0.0.1`；飞书走长连接，无入站端口
- **fail-closed**：桥掉线时默认**拒绝**需审批操作（`fail_closed = false` 可改回官方 fail-open）
- **紧急旁路**：`KCF_DISABLED=1` 后所有 hook 直接放行
- Kimi hooks 是 Beta 且 fail-open 设计，不要当作唯一安全防线

## 六、与 Python 版的关系

| | Python 版 | TS 版（本项目） |
|---|---|---|
| 分发 | pip / 源码 | **npm（`npm i -g`）** |
| 飞书 SDK | `lark-oapi` | 官方 `@larksuiteoapi/node-sdk`（WSClient + card.action.trigger） |
| 审批等待 | threading.Event | pending Promise |
| hook 入口 | `python -m kimi_code_feishu.hook` | `node dist/hook.js`（绝对路径，免 PYTHONPATH） |
| 配置文件 | 同一份，完全兼容 | 同一份，完全兼容 |
| 自检 | 33 项 | 41 项 |

## 七、开发与自检

```bash
npm install
npm run build          # tsc → dist/
node dist/selfcheck.js # 41 项端到端自检（假通道 + 假 kimi，不需要真实飞书）
npm pack               # 产出可分发的 .tgz（约 20KB）
```

## 八、常见问题

**Q：支持 Telegram / 微信吗？**
`src/channel.ts` 是抽象接口，照 `feishuChannel.ts` 实现 Telegram long-polling 通道即可复用全部逻辑；个人微信无官方机器人 API，建议走企业微信。

**Q：`kimi -p` 非交互模式固定 auto 权限？**
对，所以 `PreToolUse` hook 是唯一闸门：每次工具调用先问飞书（或命中自动规则）。请保持桥在线（fail-closed 保证桥不在线时默认拒绝）。

**Q：WSClient 断线重连？**
SDK 1.71+ 已修复旧版 `reConnect()` 定时器泄漏（上游 #177），`autoReconnect: true` 开箱即用；`feishuChannel.ts` 里留有注释说明。

**Q：Windows？**
核心逻辑跨平台；hook 命令不含 shell 变量前缀（比 Python 版更友好），但进程组终止在 Windows 上退化为单进程 kill。

## 项目结构

```
src/
├── cli.ts            # bin 入口：onboard / init / install / uninstall / run / doctor
├── appRegistration.ts # 扫码创建飞书应用（官方 Device-Flow 注册协议）
├── config.ts         # 配置加载（smol-toml + KCF_* 环境变量）
├── bridge.ts         # 核心编排：审批、进度、指令三条链路
├── feishuChannel.ts  # 飞书长连接通道（@larksuiteoapi/node-sdk）
├── channel.ts        # 通道抽象接口
├── hook.ts           # Kimi CLI hook 入口（stdin JSON → 桥 → 退出码/结构化输出）
├── hookServer.ts     # 127.0.0.1 HTTP 服务
├── kimiRunner.ts     # headless 任务运行器（spawn + 进程组管理）
├── streamParser.ts   # stream-json 容错解析
├── approvals.ts      # 待审批注册表（Promise 挂起/唤醒）
├── state.ts          # 聊天绑定、会话路由持久化
├── installer.ts      # hooks 注入/移除（自动备份）
└── selfcheck.ts      # 41 项端到端自检
```

## License

MIT
