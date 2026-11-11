# DSH 抖音助手

> **作者：dafeiyu1314520** —— 装这个包的人，第一眼会看到这个名字。
> 原作 [LockyBee/dsh-douyin-agent](https://github.com/LockyBee/dsh-douyin-agent)（MIT），这一份是在它基础上改的。

## 本仓库是改编版（基于原作者作品）

- **改编自**：[dafeiyu1314520/dsh-douyin-agent](https://github.com/dafeiyu1314520/dsh-douyin-agent)（npm 包 `dsh-douyin-agent@1.4.7`），原作者 **dafeiyu1314520**。
- **原作者的上游**：[LockyBee/dsh-douyin-agent](https://github.com/LockyBee/dsh-douyin-agent)，同样署名保留。
- 本仓库（[AAAjzx111/dsh-douyin-agent](https://github.com/AAAjzx111/dsh-douyin-agent)）**不是原作，只是个人使用中发现问题后的修改版**；版权、署名、MIT 许可均归原作者与其上游作者，本改编版同样以 MIT 发布。
- 修改集中在「私信自动回复」和「自动问候（续火花）」两条链路，不改原作的观看、人格、兴趣与日报部分。

### 改编内容（相对 1.4.7，9 个文件，+758 / −128 行）

| 问题 | 原因 | 改法 |
| --- | --- | --- |
| 读取联系人 90 秒超时 | 关注名单要点开「关注」弹层，而弹层入口中心被「N人正在直播」角标压住，Playwright 点击落空后又重试整段导航 | 改为临时标签页直达本人主页、按「关注」两字真实坐标点击、滚到底读满名单，并落盘缓存（成功 6 小时 / 失败 10 分钟冷却） |
| 私信工具整体卡死 88 秒 | `execute()` 先把任务挂到 `this.queue`，内部 `withPage()` 又往同一个队列排队，等于自己等自己 | 增加 `insideQueue` 重入标记，队列任务内不再二次排队，复用当前页 |
| 会话列表少一人 / 会话点不开 | 窗口被最小化或拖到屏幕外时，抖音消息面板停在屏幕右外侧，行有尺寸但点击落在面板外 | 进面板前用 CDP 把窗口恢复 `normal` 并纠偏到可见区域；改用真实鼠标坐标点击，点前把目标行滚进列表可视区 |
| 换了头像的好友被永久暂停 | 会话 id 由「昵称+头像」哈希得出，换头像即变，白名单旧 id 失配 | 启动与每轮轮询时按「昵称唯一 + 已关注 + 非群聊」自动重绑新 id，并迁移水位 |
| 已读不回（回复只认 `new-tail`） | 服务重启后新消息常被判成基线/旧历史，落进 `unqualified` 静默跳过 | 以「我方最后一条」为界，尾部未答消息一律补答，并用 `answered` 记账防重复 |
| 单独发的表情读成空文本 | 表情是文字气泡里的 `<img>`，`innerText` 为空 | 识别气泡内嵌表情，文本置 `[表情]`；无图的表情不挂 `media`，避免视觉理解失败导致暂停 |
| 有人暂停后永不恢复 | `paused` 只跳过不重试，且 `pausedAt` 缺失导致自愈失效 | 暂停自愈（6 分钟、上限 20 次），发送成功即清零；会话列表里已消失的好友只记原因不再死循环复活 |
| 兜底扫描从不执行 | 扫描条件要求「一个红点都没有」，而暂停好友的死红点让条件恒假 | 改为按时间兜底（每 60 秒抽 5 位、跳过已读与暂停），红点只作加速提示 |
| 问候一条就停、要人工核对、要手动重开 | 发送后回读不到新气泡 → 判 `uncertain` → 抛错 `halt()` → `paused` 卡住启动 | 不再停机：记 `uncertain` 继续下一位；下一轮自动回读会话核对（有则确认、无则记未发送且不重发）；`paused` 恒 `false`；仅许可撤回/失去锁/不在时段才停 |
| 关机后要手动点开始 | 服务不持久化「是否该自启」 | `chat-policy.json` / `spark-policy.json` 增加 `autoStart`：启动成功置真、主人手动停止置假、进程退出不改；DSH 启动后 25 秒（私信）/45 秒（问候）自动拉起，失败按阶梯重试 |
| 回复带 `[自动回复]`、问候带 `[自动问候]` | 发送前统一加前缀 | 去掉前缀，提示词要求直接输出正文；草稿守卫改用内容比对而不是前缀识别 |

改动文件：`chat-browser.mjs`、`chat-service.mjs`、`core.mjs`、`spark-service.mjs`、`dsh-plugin.mjs`、`native-settings.mjs`、`chat-agent.mjs`、`spark-agent.mjs`、`native-spark-greeting.mjs`。

让 DSH 里的 DeepSeek（大肥鱼）自己刷抖音：搜索、换片、看真实画面，把有意思的内容记下来，并在你许可的范围内分享给好友。

在专用 Edge 里浏览电脑网页版抖音：开头先抓 6 帧拼成一张采样图，让模型决定看不看；决定看之后按秒抽帧，拼成最多三张故事板，连同带时间轴的弹幕和转写一起交给模型。所有外发功能默认关闭，每一项都有独立开关、次数上限和时间限制。这是第三方适配，不是 DeepSeek 官方出品。

## 能做什么

| 功能 | 说明 | 默认 |
| --- | --- | --- |
| 自主观看 | 按人格和兴趣自己搜索、换片、继续看或停止，并给出理由 | 需手动开始有限轮次 |
| 兴趣与人格 | 兴趣来自实际观看进度和已确认行为，不是看到主题就算喜欢 | 随观看自动积累 |
| 时间限制 | 每日允许时段（北京时间）加单轮时长，到点视频真的暂停 | 单轮 10 分钟 |
| 静默观看 | 静音，核对窗口归属后尝试最小化（仍是有窗口的 Edge，不是 headless） | 关闭 |
| 观看日报 | 把当天实际看过的标题、作者、链接汇总成 Markdown，不调用模型 | 可手动生成，每轮观看结束后也会尝试生成 |
| 主动分享 | 通过官方分享界面把当前看过的作品发给许可好友，每天默认 3 次 | 关闭 |
| 自动问候 | 每位许可好友每天最多一次，合计默认 2 次，带「自动问候」标记 | 关闭 |
| 私信自动回复 | 只处理你勾选的最多十位好友，只回复启动之后的新消息 | 关闭 |
| 公开评论 | 只在作品播到结尾时问一次，同一作品永久只评一次，不限条数 | 关闭 |
| 画面理解 | 开头 6 格采样决定看不看；决定看之后整条按秒抽帧，拼成最多 3 张故事板（末尾不足 6 格不拼） | 随观看自动 |
| 弹幕与转写 | 抓当前作品的弹幕，按时间标注取高赞几条；对白按 10 秒切段转写，合并成带时间轴的整条文本 | 随观看自动 |
| 音频理解 | 本地 Whisper 转写对白，可选 MiMo 或 MiniMax 云端 | 关闭 |
| 磁盘清理 | 每轮开场删掉两天前的故事板和采样图，只清图片，不动观看记录 | 每天自动 |

发送结果不确定时一律暂停，不会自动重发。

## 两种用法

| | 插件版 | 软件版 |
| --- | --- | --- |
| 在哪用 | DSH 的「设置 → 刷抖音」，全部用按钮操作 | 独立的 Windows 桌面软件，对话式下任务 |
| 模型 | 用 DSH 里已配置的提供商 | 用你自己填的 DeepSeek API Key |
| 版本 | 1.4 | 已打包的是 1.2.0，1.4 尚未打包 |

两者共用同一份人格、兴趣和记忆，但同一时刻只会运行一个自主观看。

## 快速开始（插件版）

### npm 安装

在 DSH Desktop 自带终端中运行：

```powershell
dsh plugin --profile desktop add dsh-douyin-agent-plus@1.4.9
```

或直接从本仓库安装（不经过 npm）：

```powershell
dsh plugin --profile desktop add github:AAAjzx111/dsh-douyin-agent#v1.4.9
```

> 两种形式装的是同一份代码，包名与上游 `dsh-douyin-agent` 互斥：两套插件注册同一个 bundle id（`douyin-browser`），同一个 profile 里只能装一个。装这个之前先把原作卸掉，否则启动时会争同一个入口。

需要 Windows、已安装 Microsoft Edge 和 DSH 0.2.0-rc.2，以及一个独立的 **Node.js 22.13 或更高版本**（插件要用它单独起浏览器进程；装了 Node LTS 就行，没装的话点「开始自主观看」会提示下载地址，也可以用 `DOUYIN_NODE_EXECUTABLE` 指定已有的 node.exe）。安装后按宿主提示重新加载，在设置中打开“刷抖音”；抖音登录和验证由使用者自行完成。市场收录与 npm 包发布分别同步，不能把发布成功当成市场已刷新。

### 从源码安装


需要 Windows、Microsoft Edge、Node.js 22.13 以上，以及 DSH 0.2.0-rc.2 系列（已在 DSH Desktop 2.0.17 上核对过设置页）。

```powershell
git clone https://github.com/LockyBee/dsh-douyin-agent.git
cd dsh-douyin-agent
pnpm install --frozen-lockfile
$dshInstallDirectory = 'C:\Apps\DSH Desktop' # 替换为正在使用的 DSH 安装目录
.\install-native.ps1 -DshRoot $dshInstallDirectory
```

第一条命令安装依赖；不带 `-Install` 的脚本只做检查，不改配置也不开窗口。确认无误后完全退出 DSH，再执行：

```powershell
.\install-native.ps1 -DshRoot $dshInstallDirectory -Install
```

重新打开 DSH，在「设置」里找到「刷抖音」，按这个顺序用：

1. 基础设置：选提供商和模型（模型必须支持图片），保存。
2. 视频观看：点「打开抖音」，在专用 Edge 里自己登录或过验证。
3. 设置允许时段和单轮时长，点「开始有限轮次」，再点「开始自主观看」。

安装细节和本机现有入口的说明见 [插件说明](docs/plugin.md)。

## 当前验证状态

| 状态 | 内容 |
| --- | --- |
| 真实环境验证过 | 推荐播放、搜索、上下切换、暂停、画面采样、限时到点暂停；旧版 DSH 原生工具调用；表情图片采样；一次人工授权的好友转发；DSH 2.0.17 中设置页挂载并读回状态；2026-10-30 两条真实的自动问候（拿到消息 ID，平台火花未验证） |
| 只有合成测试 | 自主分享、行为偏好、自主评论、静默、日报、抽帧故事板与弹幕的真实密度 |
| 还没验证 | 抖音最小化后的持续播放、真实评论区、收到新私信后的完整自动回复、MiMo 与 MiniMax 云端、标准 bundle 安装 |

合成测试用的是替身模型和临时页面，不能当作真实抖音上能用的证据。最新测试数字和已知失败见 [v10 验证记录](docs/verification/native-v10.md)。

## 目录

| 位置 | 内容 |
| --- | --- |
| `dsh-plugin.mjs`、`client.js`、`cordis.bundle.yml` | 原生插件入口、设置页前端、标准 bundle 声明 |
| `tool-definitions.mjs` | 32 项工具目录，插件和软件共用 |
| `native-*.mjs` | 设置页后端、模型路由、人格注入、问候与观看决策 |
| `core.mjs`、`browser-*.mjs` | 专用 Edge 的控制、采样、限时 |
| `video-limits.mjs`、`task-limits.mjs`、`watch-mode.mjs` | 时段与轮次、任务预算、静默 |
| `autonomous-*.mjs`、`spark-*.mjs`、`daily-report.mjs` | 自主观看、分享、评论、问候、日报 |
| `frame-grab.mjs`、`danmaku.mjs`、`capture-session.mjs` | 页面内抽帧与故事板拼接、弹幕抓取与排序、素材清单与音频段归位 |
| `media-cleanup.mjs` | 开轮时清理两天前的故事板和采样图 |
| `chat-*.mjs`、`message-tracker.mjs`、`outbound-send.mjs` | 私信自动回复和统一的发送账本 |
| `memory.mjs`、`persona-memory.mjs`、`qq-sync.mjs` | 共享记忆、人格卡、QQ 侧同步 |
| `app.mjs`、`api-agent.mjs`、`public/`、`start-api.*` | 旧的本机 HTTP 控制台（`http://127.0.0.1:3218`） |
| `desktop/` | Electron 桌面软件的源码、打包脚本和上游许可证 |
| `media/` | 可选音频模块，内置三份社区项目源码 |
| `tests/`、`verification/` | 单元测试，以及实机验收脚本 |
| `skill/SKILL.md` | 给模型看的使用说明 |

## 文档

| 文档 | 内容 |
| --- | --- |
| [插件说明](docs/plugin.md) | 插件安装、设置页逐项说明、预算、各项外发的规则 |
| [独立软件说明](docs/standalone-api.md) | 独立 API 控制台和软件版的配置 |
| [详细说明](docs/details.md) | 原 README 全文，按时间累积，内容多 |
| [功能复用与来源](docs/reuse.md) | 参考和复用的开源项目，以及边界 |
| [docs/verification/](docs/verification) | 各版本的测试记录 |
| [desktop/README.md](desktop/README.md) | 桌面软件的构建和使用 |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | 第三方许可证 |

## 开发

```powershell
pnpm test
pnpm run test:native
```

`pnpm test` 会起临时 Edge 页面，不碰真实抖音和你的账号。运行状态、浏览器资料、密钥、数据库、私信正文和联系人信息都只保存在本机，不进入仓库。

## 许可证

本项目原创代码采用 [MIT](LICENSE)。第三方源码和依赖的原许可证、版权及通知见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

公开准备、分发包检查与社区市场申请见 [发布记录](docs/publication.md)。
