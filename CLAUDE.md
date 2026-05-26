# html-video 项目工作区

> Open-source HTML→Video meta-layer。让本地 coding agent 跨多个渲染 engine（Hyperframes / Remotion / Motion Canvas / Revideo）一站式做 HTML 视频。
> 启动时间：2026-05-26（继 OD / HA / OD-pitch / OD-landing 之后的下一代 nexu-io 开源产品）

## 角色与边界

- **角色**：T9（端口段 **3071-3079**）—— 现有 T1-T8 已分配
- **职责**：html-video 项目的产品定位 / 架构 / engine 适配器 spec / 模板生态 / agent skill 设计 / 文档 / 公开 launch 物料
- **不做**：
  - 跨项目协调（T1 主控的活）
  - OD 主线开发（T5 `open-design` 工作树）
  - 增长策略 / OKR（T2 `opendesign-growth`）

## 产品定位（决策时间线）

- **2026-05-26 启动思路**：Joey 最初以为 Hyperframes 是闭源 SaaS，想做 "HTML 视频开源整合工具"。调研发现 Hyperframes 已经是 Apache-2.0 开源 + 21K★ + agent-native，跟 Joey 设想的产品 1:1 重合。
- **2026-05-26 定位拍板**：放弃"做 HF 杀手"的正面竞争路线，改走 **Meta-aggregator** —— 把 HF / Remotion / Motion Canvas / Revideo 都包成可选 backend，agent 选 engine + 模板 + 一键出片。差异化明确，跟 HF 不正面撞。

### 关键差异化 vs Hyperframes

| 维度 | Hyperframes | html-video |
|---|---|---|
| 渲染引擎 | 单一（GSAP+Puppeteer） | 多引擎 pluggable |
| Authoring 范式 | 单一（HTML+CSS+GSAP） | 跟随 backend（HTML/React/TS-generator 都行） |
| Agent 能力 | 自家 skill | 跨引擎 agent 决策 + skill 注入 |
| 模板生态 | 自家曲库 | 跨生态 curated + 社区贡献 |

## 目录结构

```
html-video/
├── README.md                  公开门面（对外，已立）
├── CLAUDE.md                  本文件，内部 working notes
├── LICENSE                    Apache-2.0
├── .gitignore                 通用
├── notes/                     迭代笔记 / RFC 草稿 / 决策记录
├── research/                  竞品调研 / engine spec 草案 / API 探索
└── assets/                    素材（截图 / 草图 / launch 物料）
```

代码骨架（adapter spec、CLI、studio 等）等架构定型后另起 `core/` `adapters/` `cli/` `studio/` 等目录。

## 当前状态（2026-05-26）

- ✅ 项目目录骨架建好（notes/ research/ assets/）
- ✅ README.md（公开门面）+ LICENSE（Apache-2.0）+ CLAUDE.md（本文件）
- ✅ git init 完成 main 分支首次 commit（无远端）
- ⏳ 还没建 GitHub repo（等 Joey 拍板时机再推到 nexu-io org）
- ⏳ 还没写代码

## 与姊妹项目的关系

| 项目 | 角色 | 关系 |
|---|---|---|
| `open-design` (T5) | OD 主线 maintainer 工作树 | 设计资产侧；本项目是视频侧；同 nexu-io org，可以共享部分 skill 基建 |
| `html-anything` | OD 的 sister 开源（HTML 模板/页面） | 命名同 family（"HTML X"），定位互补：HA 做 HTML 静态页、本项目做 HTML 视频 |
| `od-pitch` (T6) | 路演 deck | 启动时如果做 launch deck，可以复用 od-pitch 的 magazine/recruiting 同款风格 |
| `growth-dashboard` (T7) | 数据罗盘 | 上线后增加 html-video 的 stars/forks/issues 监控 |

## 写操作守则

- 任何对外 publish 动作（CF Pages / GitHub repo create / 推 main / launch tweet / 公众号）**每次都先告诉 Joey**
- 改动 README.md 这种"公开门面"前先 review，避免误更新对外定位
- 第一次 push 到 nexu-io/html-video 是高敏感动作，要 Joey 明确点头 + 选好 launch 时机

## 命名 & 标语备忘

- 项目名：`html-video`
- 公司名 / org: `nexu-io`
- 推荐 tagline 候选：
  - "HTML→Video meta-layer for coding agents"（直白）
  - "Bring your agent. Pick any engine. Render any video."（口号化）
  - "One agent, every HTML video engine."（最短）
- 选哪个等公开发布前定
