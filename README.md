# competition-radar · 参赛机会雷达

**在线看板：<https://logic77lhl.github.io/competition-radar/>**
（深链可收藏某一天：`…/competition-radar/#daily/2026-11-16`）

云端每天 **01:00 UTC（北京时间 09:00）** 由 GitHub Actions 采集并发布，**不需要本机开机**：
`radar.mjs` 采集 → `tools/export-static.mjs` 把看板导出到 `docs/` → 提交台账与站点 → GitHub Pages。
采集**全部**失败时流程停在那一步、不发版，站点保留昨天的数据，不会发一份「今天没有新赛事」的假数据；
部分来源失败照常发布，但看板「来源健康」页会标红。

> 云端接管之后，本机的计划任务只是另一份副本。本地再跑一次会和仓库里的台账分叉；
> 想在本地看到最新数据，先 `git pull`，或者直接看线上站点。

每天自动采集「在办的 AI / AI4S 竞赛」，和昨天比，只把**变化**告诉你：
哪些是新出现的、哪些快截止了、哪些改期了、哪些源挂了。

它解决的问题是：赛事分散在十几个平台，靠人肉刷既刷不全也记不住截止日。
本工具不做「推荐」，只做**发现 + 提醒**，把「有没有新的」这件事变成每天早上的一条摘要。

---

## 一、每天会发生什么

已注册的 Windows 计划任务：**`DSH-Competition-Radar`，每天 09:00**。

它跑 `run-daily.ps1` → `radar.mjs`，然后：

1. 并发抓取 12 个来源（约 8–14 秒，取决于 Kaggle 翻页和网络抖动）；
2. 归一化 + **跨来源去重**（同一场比赛同时挂在 Kaggle 和 ML Contests 上只算一条）；
3. **把「报名截止」和「提交截止」分开算**，取更早的那个作为真正卡人的日期
   （Kaggle 上这两个日期常常差一周，错过报名就完全没机会了）；所有日期统一换算成**北京时间**；
4. 与 `state/registry.json`（历史台账）做 diff，算出**新增 / 截止日变更 / 重新开放 / 刚刚截止**；
5. 按「临近截止阶梯」T-30 → T-14 → T-7 → T-3 → T-1 → T-0 提醒，**同一档只提醒一次**（不会天天刷屏）；
6. 写摘要 `state/out/latest.md` 与 `latest.html`，弹一个 Windows 通知。

> 通知实测可用（本机 pwsh 7 的 WinRT toast 不可用、PS 5.1 报 0x80073D54，
> 所以走的是 `NotifyIcon` 气泡，已验证会弹出）。如果哪天没弹，**摘要文件仍然是权威结果**。

## 二、看结果

**首选：看板。** 一个本地网页，能筛选、搜索、点开看细节，不用再翻 Markdown。

```powershell
cd C:\Users\user\Documents\deepseek-harness\default-workspace\competition-radar

# 日常入口：没在跑就先无窗口拉起来，然后开浏览器
open.cmd                       # 或双击桌面「参赛雷达」

# 开机自启（隐藏运行，不弹控制台）+ 桌面快捷方式
install-autostart.cmd          # 取消：uninstall-autostart.cmd

# 带控制台的前台模式，调试用
start.cmd
```

看板地址 **http://127.0.0.1:7865/**，页面有：

| 页 | 看什么 |
|---|---|
| 总览 | 六个数字 + 截止压力分布 + 30 天内到期 + 新增 |
| 每日日报 | 一天一页：今天要做（3 天内）/ 新增 / 变化 / 截止压力 / 方向分布；可翻历史、复制 Markdown |
| 临近截止 / 新增赛事 / 在办总表 | 可筛选（方向、剩余天数、只看有奖金）+ 顶部全局搜索 |
| 未标截止 | 按来源分组，这些平台不给截止日，**不等于能报名** |
| 变更与截止 | 最近 7 天截止的 / 改期 / 重新开放 |
| 来源健康 | 哪个源挂了。任何一个连续失败都当问题处理 |
| 历史趋势 | 每天在办数曲线（能看出哪天采集没跑全） |
| 人工入口 | 12 个抓不到正文的平台，带链接 |

点任意一行 → 右侧抽屉：报名截止 / 提交截止 / 真正卡人的那天 / 奖金 / 主办 / 已触发过哪几档提醒 / 标签 / 原始链接。
右上角「立即采集」会真的重跑一次 `run-daily.ps1`（约 8–14 秒），不是假按钮。

> 「每日日报」和「总览」不是同一件事：总览回答「现在有什么」，日报回答「这一天发生了什么、先做哪几件」。
> 它由 `state/out/<日期>.json` 派生（缺导出时退回快照 / `history.jsonl`），**不新增采集、不改台账**。
> 数据精度分三档，页面上会明说：**结构化导出 / 快照兜底 / 只有计数** ——
> 缺「新增」「变更」时显示 `—` 或「没有记录」，不会显示成 0。
> 日报里的行点开直接跳官网（抽屉读的是今天的台账，翻旧日报会对不上）；
> 「复制日报」给的是纯 Markdown，可直接粘进群里或笔记；「打开完整摘要」是当天那份全量摘要。
> 深链可以收藏某一天：`http://127.0.0.1:7865/#daily/2026-11-11`。

> 「新增」和「最近截止」按**台账里的日期**算（`firstSeen == 当天`、截止日在最近 7 天），
> 不按「本次运行发现了什么」算。原因很实在：同一天重跑一次，那些条目已经进台账了，
> 本次运行会报 0 条新增 —— 但「今天有哪些是新的」是当天的事实，不该被重跑改写。

> 看板只读 `state/`，不改台账。它优先读 `state/out/latest.json`（每次采集写的结构化导出）；
> 这个文件还不存在时（比如刚升级）退回读快照 + 台账，并在页面上标明「快照兜底」，
> 此时「变更 / 重新开放」只能按截止日推算，会显式标注。
>
> ⚠️ 这几个 `.cmd` / `.vbs` 故意**只写英文、且用 CRLF 换行**。cmd.exe 按当前代码页逐行解析批处理，
> UTF-8 中文 + LF 换行会把行拆坏（实测报 `'l' 不是内部或外部命令`）。要改它们，别写中文、别改成 LF。

**备选：直接看文件。**

```powershell
notepad state\out\latest.md    # 今天的摘要（markdown）
start state\out\latest.html    # 排版版（浏览器打开）
dir state\out                  # 历史归档
type state\history.jsonl       # 一行 JSON 趋势
```

摘要分五段：**临近截止 → 新增赛事 → 变更与状态切换 → 在办赛事总表（按方向分组）→ 来源健康**。

## 三、手动跑 / 调参

```powershell
# 正常跑当天（会写状态）
pwsh -NoProfile -File .\run-daily.ps1

# 不写任何状态，摘要另存 .dryrun 后缀 —— 改代码时用这个
pwsh -NoProfile -File .\run-daily.ps1 -DryRun

# 只跑某几个来源（诊断）
node radar.mjs --only kaggle,mlcontests --dry-run

# 指定日期（补跑 / 造数据）
node radar.mjs --date 2026-10-20

# 不弹通知
pwsh -NoProfile -File .\run-daily.ps1 -NoToast
```

改定时时间 / 改任务名：

```powershell
pwsh -NoProfile -File .\register-task.ps1 -Time 08:30
pwsh -NoProfile -File .\unregister-task.ps1          # 停掉（采集数据保留）
```

## 四、退出码（别把故障当「今天没新赛事」）

| 码 | 含义 |
|---|---|
| 0 | 正常 |
| 2 | **所有**启用的来源都失败了 —— 这是真故障，摘要不可信 |
| 1 | 未预期异常 |
| 3 | 找不到 Node 运行时 |

部分来源失败时退出码仍是 0，但**摘要里的「来源健康」表会红**。
这张表就是用来防止「静默失败」的：任何一个源连续失败都要当问题处理。

## 五、数据来源（实测状态，2026-11-10）

| 来源 | 抓法 | 能拿到什么 | 状态 |
|---|---|---|---|
| **Kaggle** | POST `kaggle.com/api/i/competitions.CompetitionService/ListCompetitions` | 截止日、奖金、主办方、赛道标签、队伍数。全量 758 项翻 8 页 | ✅ 762 条 |
| **ML Contests** | `mlcontests.com` 页面内嵌 `data-competitions` JSON | 国际赛事全集，**含 `added` 收录日期** —— 最适合判断「有没有最新的」 | ✅ 410 条 |
| **Grand Challenge** | `grand-challenge.org/api/v1/challenges/` | MICCAI 系医学影像挑战，含平台状态与起止日 | ✅ 264 条 |
| **DataFountain** | 服务端渲染列表页 **+ ID 递进补采** | 国内赛事。列表页只渲染 30 条，新赛事根本不在里面，所以额外按 ID 往上探一个窗口（详情页返回 500 = 该 ID 不存在） | ✅ 30 条 |
| **AIcrowd** | 列表页 HTML | 研究型竞赛（NeurIPS 等） | ✅ 18 条 |
| **CodaLab** | 列表页 HTML（**必须带 `?is_active=on`**） | 学术评测（WMT 等）。不带参数会返回 1256 条含大量往届 | ✅ 379 条 |
| **DrivenData** | 列表页 HTML + 分区标题 | 公益/科学向竞赛，能区分 Ongoing / Completed | ✅ 53 条 |
| **EvalAI** | `/api/challenges/challenge/{present,future}/approved/public` | 学术评测（CVPR/ICCV/NeurIPS workshop 挑战赛大量挂这里）。**前端是 Angular 空壳，别去解析 HTML**；接口给 `start_date` / `end_date` / 主办团队 / `is_registration_open` | ✅ 3 条（另跳过 15 个 2099 占位日的常设 benchmark） |
| **Devfolio** | 页面内嵌 `__NEXT_DATA__`（react-query 缓存） | 全球黑客松。`open/upcoming/featured/past` 四组，带起止时间、报名人数、时区；主题在 `h.themes[].theme.name` 里（不是 `tags`） | ✅ 4 条（扫 25 场，AI 相关 4 场） |
| **TAIKAI** | `__NEXT_DATA__` 里的 Apollo 规范化缓存 | 欧洲黑客松。`ROOT_QUERY` 只存 `__ref`，组织/币种/行业各是一条 ref，要自己解。**列表不返回任何日期**，只有 `isClosed` → 按「未标截止」处理 | ✅ 7 条（20 场里 AI 相关 7 场，当前全已关闭） |
| **lablab.ai** | 列表页取 `/ai-hackathons/<slug>` + 详情页内嵌 JSON-LD `Event` | AI 黑客松，更新最快。标题和起止日都在详情页的 JSON-LD 里（Next.js App Router 的 flight 流，要先拼 `self.__next_f.push`） | ✅ 12 条（每次最多抓 20 个详情页） |
| **人工维护清单** | `curated.json` | 逐个抓页面核实过的国内赛事（含 AI4S 专项）；第三方转述的标 ⚠️ | ✅ 22 条 |
| CTFtime | JSON API | 网络安全 CTF 赛历 | ⏸ 默认关闭（与 AI 无关） |

### 抓不到的（摘要里会列出入口让你人工看）

天池、讯飞、百度 AI Studio、华为云大赛、和鲸、琶洲算法大赛、Devpost、Zindi、赛氪、
我爱竞赛网、AITOP100、CompeteHub —— 这些站点是**前端渲染**或 **Cloudflare 拦截**，
脚本拿不到正文。摘要末尾和看板的「人工入口」页会带链接列出来，
这是**已知覆盖盲区，不是「这些平台没有比赛」**。

### 覆盖盲区清单（2026-11-10 逐个实测过）

**被挡死的（403 / Cloudflare）**

| 站点 | 结果 |
|---|---|
| DACON（韩国最大） | 403 |
| Synapse | 403 |
| Devpost | Cloudflare 403（一直如此） |

**前端空壳（HTML 只有 2–13 KB，正文全在 JS 里）**

天池列表、飞桨 AI Studio、华为云大赛、和鲸、赛氪、CompeteHub、HackerEarth、CrunchDAO。
讯飞虽然是 Next.js，但 `__NEXT_DATA__` 只有 137 B —— 数据也是客户端取的。

**看着有货、其实不是赛事**

AITOP100 内嵌了 518 KB 的 `__INITIAL_STATE__`，解开一看是 AIGC 资讯、课程、人物访谈，
不是赛事列表 —— 别被体积骗了。

**能做但还没做（按性价比排）**

| 目标 | 现状 | 大概工作量 |
|---|---|---|
| SIGNATE（日本最大） | 列表是 Nuxt，数据客户端取，要逆向它的 API | 1–2 天 |
| TAIKAI 的截止日 | 列表不返回日期，得逐个抓详情页（详情页也是客户端取数，暂时无解） | 卡住 |
| EvalAI 的往届 | 只取了 present + future；past 有上千条，价值低 | 半天 |
| HeroX / XPRIZE | 页面有内容，但「长期悬赏」性质，见下 | 1 天 |

**刻意排除的（不是抓不到，是不该混进来）**

- **算法竞赛**：Codeforces / AtCoder / ICPC / 洛谷 —— 与 AI 无关
- **CTF**：CTFtime 内置但默认关闭
- **长期悬赏**：Immunefi / HackerOne / GitHub Bounties
- **开源活动**：GSoC / 开源之夏 —— 有截止日、算「参赛」，但性质不同

**国内大厂 / 政府赛事（结构性问题）**

CCF BDCI、讯飞、飞桨、华为云、腾讯/字节/蚂蚁/美团/京东/滴滴/快手 的算法大赛，
以及互联网+、挑战杯、数学建模、蓝桥杯 —— **目前没有一个是自动源**，
全靠 `curated.json` 手工维护（天池 9 条、我爱竞赛网 3 条就是手工进去的）。
这是现在最明显的地域盲区：12 个自动源里，只有 DataFountain 一个中文平台。

## 六、加来源 / 加人工条目

**加人工核实条目**（推荐：一次抓证，长期跟踪截止日）——编辑 `curated.json`：

```json
{
  "id": "curated:your-id",
  "name": "赛事名",
  "organizer": "主办方",
  "domain": "方向（会参与自动分类）",
  "prize": "奖金",
  "deadline": "2026-11-30",
  "status": "open",
  "url": "https://...",
  "region": "cn",
  "tags": ["ai4s"],
  "evidence": "你在页面上看到的原话/日期",
  "verifiedAt": "2026-10-16",
  "confidence": "已核实"
}
```

雷达会自动把它纳入提醒阶梯；截止后进「刚刚截止」并停止提醒。

**加自动来源** ——在 `lib/sources.mjs` 里写一个适配器（返回 `{records, note}`，
失败就 `throw`，由 `runSource` 兜住并记进健康表）。三步都要做，少一步就静默不生效：

1. 写适配器，用 `mk({...})` 造记录（`key` 要稳定，别带时间戳，否则每天都是「新增」）；
2. 加进 `ADAPTERS`；
3. 加进 `SOURCE_PRIORITY`（决定跨源去重时留谁），再在 `config.json` 的 `sources` 里注册
   （`enabled` / `label` / `home` / `note`）。

写完先单跑验证，别直接跑全量：

```powershell
node radar.mjs --only yoursource --dry-run
```

**判断一个新站值不值得写，先看三件事**（2026-11 的教训）：

- **HTML 有多大**：2–13 KB 基本是空壳，别浪费时间；几百 KB 且带 `__NEXT_DATA__` /
  `__NUXT__` / `__INITIAL_STATE__` / `self.__next_f` 才有戏。
- **数据在不在里面**：AITOP100 有 518 KB 内嵌 state，但内容是资讯不是赛事 —— 体积大不等于有用。
- **有没有官方接口**：EvalAI 的页面是 Angular 空壳，`/api/challenges/challenge/present/approved/public`
  才是正文；猜路径猜不出来时，打开页面看它自己请求了什么（`performance.getEntriesByType('resource')`）。

## 七、目录

```
competition-radar/
  radar.mjs            主编排：采集 → 去重 → 分桶 → diff → 提醒 → 渲染
  panel/               看板（本地网页，只读 state/）
    server.mjs          HTTP 服务：/api/state、/api/run、/api/log、/api/report、/api/raw
    index.html          单文件 UI（无构建步骤）
  lib/util.mjs         HTTP 重试、日期解析（ISO / "15 Oct 2026" / "2026.04.07" / 中文日期）、分类器
  lib/sources.mjs      12 个来源适配器 + 跨来源优先级表 + 黑客松关键词过滤
  lib/digest.mjs       五段式摘要（markdown + 自包含 HTML）
  config.json          开关、参数、人工查看入口清单
  curated.json         人工核实过的赛事
  run-daily.ps1        计划任务调用的包装器（找 node → 跑 → 落盘 → 通知）
  register-task.ps1    注册计划任务（ScheduledTasks 模块 / schtasks.exe 双路径）
  unregister-task.ps1  注销
  open.cmd             开看板（没在跑就先隐藏启动）
  start.cmd            前台跑看板（带控制台，调试用）
  launch-hidden.vbs    无窗口启动看板
  install-autostart.cmd / uninstall-autostart.cmd   开机自启 + 桌面快捷方式
  notes/               公众号/文章原文的抽取结果（留证）
  tools/               公众号抓取与解析、文章条目核实、通知诊断
  state/               运行期状态
    registry.json        历史台账（firstSeen / lastSeen / 报名+提交截止 / 已提醒档位 / 置信度）
    source-state.json    来源水位线（目前只有 DataFountain 的 ID 探到哪了）
    snapshots/<日期>.json 每日快照
    out/<日期>.md|.html|.json  每日摘要 + 结构化导出；latest.* 是最新一份
    log/                 运行日志（run-*.log 是包装器的，YYYY-MM.log 是雷达的）
    panel.log            看板服务的 stdout/stderr（隐藏启动时）
    history.jsonl        每天一行 JSON，用来画趋势
```

## 八、设计上的几个刻意选择

- **幂等只覆盖提醒，不覆盖采集。** 采集永远全量跑，因为「源挂了」和「今天没新比赛」
  必须能区分开；靠 `DONE` 标记跳过采集会把这个区别抹掉。
- **去重按 URL + 标题双键，保留来源优先级最高的那条**（curated > kaggle > datafountain
  > grand-challenge > drivendata > mlcontests > aicrowd > codalab），但会把被丢弃条目里
  更有价值的奖金/主办方/截止日**并回来**，不因为去重丢数据。
- **不展示截止日 ≠ 能报名。** AIcrowd / CodaLab / DrivenData 的列表页不给截止日，
  这些条目单独放一节并标注「需点进去确认」，不混进「临近截止」。
- **常设练习赛单独折叠。** Kaggle 的 Titanic 之类截止日挂在 2030 年，属于永久开放的
  练习场，不算竞赛，折叠显示，也不进「新增」。
- **分类器用词边界匹配。** 早期版本用 `includes('gene')`，结果 `general` 命中，
  把「人工智能+创新创业大赛」误判成 AI4S。现在词表里带 `*` 的是词干，其余一律
  `\b...\b`，并已加进回归测试。
- **采集快慢只取决于最慢的那个源。** Kaggle 翻页是唯一没法并行的（`pageToken` 链式），
  所以一次要 500 条，把 8 页压成 2 页（实测 100 条/页 2.2s，500 条/页 1.6s）；
  lablab 的详情页单页 0.6–2.7 秒，12 个一次全发出去。全局并发 6 —— 12 个源分散在
  不同主机上，再往上只是给上游添堵。加这四个源之前是 18 秒，现在是 9–14 秒。
- **黑客松来源要过关键词。** Devfolio 上 8 成场次是「No Restrictions」的通用黑客松，
  TAIKAI 里混着 Web3 和航天。全量收进来会把「在办总表」灌成噪声，所以按
  `settings.aiHint` 过一道；但 note 里必须报「扫到 N 场，AI 相关 k 场」，
  否则「被过滤掉了」和「平台今天没比赛」就混成一件事了。

## 九、拿到一篇公众号 / 聚合站文章怎么办

赛事信息大量流在微信公众号里（例如「【10月比赛合集】27场AI大奖赛」这类 CompHub 转述稿），
而公众号对无头抓取会甩验证页。这里的处理流程是固定三步，工具都在 `tools/`：

```powershell
# 1) 抓正文（浏览器 UA + referer 能绕过验证页；页面里塞了几 MB base64 图片，抓完是 3MB 属正常）
node tools\fetch-wechat-article.mjs <文章URL>
# 2) 抽出纯文本 + 外链，落到 notes\
node tools\parse-wechat-article.mjs
# 3) 把文章里那些雷达抓不到的赛事（天池/Zindi/…）逐个去官网核实
node tools\verify-article-entries.mjs
```

**核实结论决定它进哪里**：

- 官网能读到的 → 写进 `curated.json`，`confidence` 标「已核实」或「部分核实」；
- 官网是纯前端渲染、读不到的（**天池就是这一类**）→ 也写进 `curated.json`，但 `confidence`
  必须写「未核实（第三方转述）」，摘要里会挂 ⚠️；
- 两边都没有的 → **不写**。

这条流程已经跑过一次，见 `notes/2026-10-16-公众号-10月比赛合集-27场.txt`。
它当时暴露了两个真问题，都已修掉：

1. **漏赛事**：文章里的 DataFountain「6G/B6G 多用户 MIMO」（1176）不在雷达里 ——
   因为 DataFountain 列表页只渲染 30 条。这才有了上面的 **ID 递进补采**。
2. **日期口径不一致**：文章写「报名截至 2026-10-16」，雷达写「2026-10-22」。
   两个都对，但说的不是同一件事 —— 文章用的是**报名截止**且是**北京时间**，
   雷达当时只取了 Kaggle API 的 UTC 提交截止。修完之后两边完全对齐
   （RSNA 报名 10-16 / 提交 10-23；Gemma 4 报名 11-26 / 提交 12-03；Enveda 报名 12-08 / 提交 12-15）。

## 十、和 DSH 自带定时提醒的关系（备选方案）

DSH 本身有一个 `schedule` 插件（`schedule_create` 支持 `daily` / `cron`），
但它**不在随发行版交付的 Web 组合里**，需要在插件管理页的「官方」分组里启用
实验性 bundle `@deepseek-ai/dsh-experimental-schedule-bundle`（或写进 profile 的
`dsh.profile.bundles`）并重启。

它的优势是提醒能直接进会话、由模型带着上下文做判断；本雷达的优势是**不依赖 DSH 是否在运行**，
而且采集是确定性的、可复现、失败可见。两者可以并存：
用本雷达做「发现 + 兜底」，再用 schedule 插件把摘要喂进会话做「解读」。

## 十一、验证记录（2026-10-16 / 11-10 实测）

| 项 | 结果 |
|---|---|
| 全量采集 | 8/8 来源成功，1798 条记录，8–14 秒 |
| 在办且有截止日 | 56 条（引入报名截止口径后从 41 条上升到 56 条） |
| 跨来源去重 | 合并 131 条重复 |
| 计划任务注册 | `DSH-Competition-Radar`，每天 09:00，`LastTaskResult = 0` |
| 计划任务实跑 | 触发后 `latest.md` 更新、日志出现「通知：已弹出」「完成」 |
| 新增检测自测 | 从台账里删掉 3 条后跑次日，精确报出这 3 条（含取证线索） |
| 提醒幂等 | 首日 24 条提醒，同日重跑降到 11 条（已报过的档位不再重复） |
| 通知 | `NotifyIcon` 气泡可用；WinRT toast 在本机不可用（已自动降级） |
| DataFountain ID 补采 | 从列表页 30 条里补出列表没有的 1176，并滤掉 1171–1175 的运营测试题 |
| 报名截止口径 | 与公众号文章交叉验证一致（Gemma 4 / Enveda / RSNA 三条完全对上） |
| 公众号流程 | 抓取 → 抽文本 → 逐条核实 → 入库，14 条第三方转述入库并标 ⚠️ |
| 看板（2026-11-10） | 9 个视图全部渲染、无 console 报错；`/api/state` 返回 200，36 在办 / 19 临近 / 6 新增 / 453 未标截止 / 21 常设，与当天摘要逐项对齐 |
| 看板数据源 | 新增 `state/out/latest.json` 结构化导出；文件缺失时退回快照 + 台账，并在页面标注「快照兜底」 |
| 每日日报（2026-11-12） | 新增 `/api/report`（只读派生）；导出 / 快照 / 无记录三种精度分别实测（11-12、11-09、10-01），缺「新增 / 变更」时显式标「未记录」而不是 0；数字与当天 `latest.json` 对齐 |
| 看板「立即采集」 | 在副本里实测：POST 202 → 11.6s → `lastRun.code = 0`，页面自动切到结构化导出；重复点击返回 409 |
| 看板隐藏启动 | `wscript launch-hidden.vbs` 拉起后 node 无窗口、`MainWindowTitle` 为空、7865 监听正常，日志落 `state/panel.log` |
| 新增来源（2026-11-10） | EvalAI 3 / Devfolio 4 / TAIKAI 7 / lablab 12 条，12/12 源正常；总记录 1805 → 1831，在办 36 → 43 |
| 采集提速（同日） | Kaggle `pageSize` 100→500（8 页→2 页）、lablab 12 个详情页一次并发、全局并发 3→6；墙钟 18.2s → 10.1s |
