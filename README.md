# kimi-code-feishu

让 **Kimi Code CLI** 连上飞书机器人：在任何地方用手机给 Kimi Code 派任务、看实时进度、批准/拒绝权限请求。

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

> 重启正在运行的 kimi 会话后生效；CLI 内 `/hooks` 可确认。hook 用绝对路径直接调用。

后台常驻（推荐 systemd 用户服务，崩溃自动重启、开机自启）：

```bash
sh deploy/install-service.sh     # 渲染并启用 ~/.config/systemd/user/kimi-code-feishu.service
journalctl --user -u kimi-code-feishu -f   # 看日志
# 或简单方式：nohup kimi-code-feishu run > ~/.kimi-code-feishu/bridge.log 2>&1 &
```

> 桥在线很重要：fail-closed 设计下桥掉线 = 需审批操作全部默认拒绝。桥每次启动会往最近活跃的聊天发一条「✅ 桥已上线」（附 Dashboard 地址），出门在外能确认它活着。

## 四、使用方法

### 飞书里（手机/电脑均可）

| 输入 | 作用 |
|---|---|
| `帮我跑一下测试并修复失败用例` | 直接派任务（流式回报，危险操作弹审批卡片） |
| `/bind /home/me/projects/foo` | 绑定本聊天的工作目录 |
| `/dashboard` | 临时开启实时输出面板（`/dashboard off` 关闭） |
| `/a` | 列出 tmux 里的终端会话；`/a 序号` 绑定到本聊天 |
| `/t <文本>` | 向绑定会话注入文本+回车（空文本=只回车）——远程回答提问、批准提示 |
| `/s` | 查看绑定会话当前画面（capture-pane 快照） |
| `/c` | 审批池列表；`/c 序号` 或 `/c 路径` 切换（进池的终端会话才弹审批卡/推进度） |
| `/new` / `/stop` / `/status` / `/id` / `/help` | 会话管理 / 终止 / 状态 / 查 open_id / 帮助 |

### 远程操控终端会话（tmux / pts 注入）

`/a` 列出**所有**活着的 kimi 终端会话（`ps` 全量扫描 + 进程树匹配），分两级：

- **⌨️可控（tmux）**：`kimi-code-feishu tmux` 启动的会话，`/t` send-keys 注入、`/s` capture-pane 抓屏
- **⌨️可控（pts）/ 👀仅发现**：普通终端里的 kimi。本机已启用 `legacy_tiocsti=1` + 免密 sudo 时可注入（TIOCSTI 把按键塞进终端输入队列）；不满足时降级为仅发现——审批卡走 hook 不受影响，但无法注入/抓屏

```bash
kimi-code-feishu tmux     # 在 tmux 里启动 kimi（kcf-* 命名），Ctrl+B D 脱离
```

- 飞书发 `/a` 列出会话（序号/目录/可控性），`/a 2` 绑定到本聊天；`/s` 看一眼屏幕再决定敲什么
- `/t` 注入等价于坐在终端前打字：回答 `AskUserQuestion` 提问、对权限提示敲 `y`、下新指令都行
- 普通消息与 `/t` 的分工：普通消息 = `kimi -p` 派**新任务**（模型自行决断，不提问）；`/t` = 接管**已活着的**交互会话（它卡住等你救）
- pts 注入依赖：`/etc/sysctl.d/90-kcf-tiocsti.conf`（`legacy_tiocsti=1`）+ 免密 sudo；其他机器不满足时自动降级，不影响其余功能

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
- 配置了 `dashboard_public_url` 后，卡片底部附「📊 查看实时输出」链接，点开看清现场再决定

### 提问卡片（tmux 交互会话）

tmux 会话里模型调 `AskUserQuestion` 时，hook 直接放行让 TUI 出题，同时飞书弹出选项卡片：

- 点选项 = 桥把对应**数字键敲进终端**，模型拿到的是真实 UI 作答（不是 hack 回传）
- 多选题可多点后「✔️ 确认选择」；「🚫 拒绝回答」= 敲 Esc
- 自定义答案：用 `/t` 直接打字输入
- 目前支持单题卡片；多题提问或会话不在 tmux 里时回落普通审批/终端作答

### 监控终端会话

终端里跑 `kimi --yolo`，审批闸门即完全交给飞书卡片，出门在外也能远程点头。

### 审批池（/c）

多个终端会话同时跑时卡片会刷屏，审批池控制**哪些会话**走飞书：

- **按目录（cwd）记池**：`/c` 列出的会话对应目录进池后，它的 PreToolUse 才弹审批卡、进度才转发；池外会话 hook 直接放行，回落终端原生权限流程（你在机器前正常点，飞书完全安静）
- 桥自己派的任务（`kimi -p`）不受池限制，永远弹卡
- 兜底：池外会话在终端进入权限等待时，桥发一条被动通知（`PermissionRequest` 事件）——不会无声无息卡住，`/c` 加池或 `/a` 绑定后 `/t` 作答即可
- 池持久化在 `state.json`，重启不丢

## 五、Dashboard（按需开启的 WebUI）

Dashboard 采用**按需开启**的安全模型——桥启动时**不**开启，用的时候才临时拉起：

```
/dashboard      # 飞书里发送，几秒后收到带 token 的公网链接
/dashboard off  # 手动关闭（页面上的「关闭 Dashboard」按钮等效）
```

- 实时展示所有任务的 **kimi 终端输出**（stdout / stderr / 任务启停 / 审批动作），按聊天过滤、自动滚动，新打开的页面回放最近 500 条事件
- **页面只读**，唯一操作是「关闭 Dashboard」按钮
- 每次开启：**新随机 token + 新 cloudflared 隧道域名**（quick tunnel，无需公网 IP 和配置），上次的链接全部作废
- **双阈值自动关闭**：没有打开的页面约 3 分钟关；页面停看（心跳停）10 分钟关——离开后不会一直挂在公网上
- 配置见 `[dashboard]` 节：`dashboard_idle_timeout_page` / `dashboard_idle_timeout_nopage` / `dashboard_public_url`（固定域名才填）/ `cloudflared_bin` 等

> ⚠️ 终端输出可能包含敏感信息，**带 token 的链接等同于终端内容本身**，请勿转发；cloudflared 隧道全程 HTTPS。

## 六、安全设计

- **白名单**：仅 `allowed_user_ids` 中的 open_id 能发指令、点卡片；其他人点击被忽略并记日志
- **不出本机**：hook 服务只听 `127.0.0.1`；飞书走长连接，无入站端口
- **Dashboard**：按需开启 + 一次性 token/域名 + 双阈值自动关 + 页面只读，公网暴露窗口最小化
- **fail-closed**：桥掉线时默认**拒绝**需审批操作（`fail_closed = false` 可改回官方 fail-open）
- **紧急旁路**：`KCF_DISABLED=1` 后所有 hook 直接放行
- **对话日志**：完整对话落盘 `~/.kimi-code-feishu/logs/YYYY-MM-DD.jsonl`（含终端输出，可能敏感；文件 600/目录 700，默认保留 30 天自动清理）
- Kimi hooks 是 Beta 且 fail-open 设计，不要当作唯一安全防线

## 七、开发与自检

```bash
npm install
npm run build          # tsc → dist/
node dist/selfcheck.js # 79 项端到端自检（假通道 + 假 kimi，不需要真实飞书）
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
核心逻辑跨平台；hook 命令不含 shell 变量前缀，但进程组终止在 Windows 上退化为单进程 kill。

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
├── dashboard.ts      # 按需开启的 WebUI（SSE 实时输出，双阈值自动关）
├── tunnel.ts         # cloudflared quick tunnel 托管（/dashboard 开启时拉起）
├── tmux.ts           # tmux/pts 会话发现 + 注入 + 抓屏
├── chatLogger.ts     # 飞书对话日志落盘（JSONL 按天分文件）
├── streamParser.ts   # stream-json 容错解析
├── approvals.ts      # 待审批注册表（Promise 挂起/唤醒）
├── state.ts          # 聊天绑定、会话路由持久化
├── installer.ts      # hooks 注入/移除（自动备份）
└── selfcheck.ts      # 79 项端到端自检
```

## License

MIT
