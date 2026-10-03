# meme-lab：土狗 / meme 币研究实验室

> 状态：**活跃开发中（Active）**
> 项目分级：L1 个人实验（娱乐 + 研究导向）
> 更新日期：2026-10-03
> 许可：Apache-2.0（见 `LICENSE`）· 安全问题请见 `SECURITY.md`

## 1. 这个项目是什么

一个专门研究 **Solana 生态土狗 / meme 币早期交易** 的个人实验室。目标不是"造一个自动印钞机"，而是：

1. 建立一套**可复用的观察、筛选、记录体系**。
2. 用真实记录回答一个具体问题：**在扣掉手续费和归零之后，是否存在可复制的正期望？**
3. 长期沉淀成一套带数据的打法手册，而不是靠感觉。

初始规模：**100 USDT**，按"门票钱"对待，可全额亏损。

## 2. 非目标（明确不做）

- 不承诺任何收益率；`100 → 10000` 是挑战目标，不是预期，成功概率极低。
- 不做市场操纵：不刷量、不对敲、不联合拉盘、不参与捆绑盘。
- 不代管他人资金，不对外募资，不卖信号。
- 不在第一阶段写自动下单 bot（见 `docs/06` 的理由）。

## 3. 红线

1. **私钥安全**：只用专门的 burner 钱包，绝不复用主钱包；不签不认识的合约；授权后 revoke。
2. **资金上限**：100 USDT 封顶，触及即停，不追加、不补仓、不加杠杆。
3. **只读优先**：监控/筛选工具全部只读，执行层必须经过 Stage Gate 才启用。
4. **参数必须核验**：文档中涉及手续费、API 额度、合约地址等易变信息，落地前查官方文档。

## 4. 目录结构

```
meme-lab/
├── README.md                      # 本文件：定位、红线、导航
├── AGENTS.md                      # 仓库级工程约定
├── docs/
│   ├── 01-市场地图.md              # Solana meme 生态分层与生命周期
│   ├── 02-交易原理.md              # AMM/bonding curve/MEV/交易生命周期
│   ├── 03-识别与风控.md            # 归零类型、链上检查清单、评分卡
│   ├── 04-数据与工具链.md          # RPC、数据源、监控技术、成本
│   ├── 05-打法手册.md              # 资金结构、入场、出场、纪律（本地保留，不公开）
│   ├── 06-技术方案-预警脚本.md      # 只读预警+筛选系统的架构设计
│   ├── 07-实验记录规范.md          # 交易日志字段、复盘指标、模板
│   ├── 08-风险与合规.md            # 四类风险、钱包安全 SOP、合规提示
│   └── 09-路线图与验收.md          # Stage Gate、里程碑、时间盒
├── journal/                       # 实验记录（真实交易与复盘）
│   ├── trade-log.csv              # 逐笔交易日志
│   └── daily-template.md          # 每日复盘模板
├── src/                           # 只读预警/筛选系统（采集→补齐→评分→推送→落库）
├── scripts/                       # 调试脚本：dry-run / fetch-once / watch-logs / probe-creation
├── test/                          # 离线单元测试
└── data/                          # 本地数据落盘（不提交 git）
```

## 5. 阅读顺序

第一次进入按这个顺序读：`01 → 02 → 03`，先把市场和风控搞懂；
要动手写工具时读 `04 → 06`；每笔交易前后用 `07`；上线前核对 `08 → 09`。
（`05` 打法手册属于个人策略，仅在本地保留，不在公开仓库中。）

## 6. 快速开始（只读预警系统）

```bash
npm install
cp .env.example .env          # 填 SOLANA_RPC_URL / TELEGRAM_*（可留空，留空则打到 stdout）
npm run typecheck             # 类型检查
npm test                      # 单元测试（离线）
npm run dry-run               # 离线端到端跑样例数据，不联网
npm start                     # 订阅主网新币事件并推送
```

排障：

- **`fetch failed` / RPC 连不上**：本机走代理时，Node 的 fetch 默认不读 `http_proxy`。
  启动脚本已带 `NODE_USE_ENV_PROXY=1`；如果自己写入口脚本，也要带上这个变量。
- **`getProgramAccounts` 报错**：部分公共 RPC 禁用了该接口，持币地址数会降级为未知，
  对应候选会进入人工复核而不是被判 pass。换托管 RPC 可解决。
- **`ws error: connect ETIMEDOUT`**：订阅走的是 WebSocket，不认代理环境变量。
  已在 `src/proxy.ts` 里注入代理 agent，无代理环境会自动跳过。
- **`429` 大量出现 / 队列打满**：公共 RPC 撑不住这个事件量。
  持续运行请用专用 RPC，或收紧 `collector.logIncludes` 过滤。

辅助脚本：

```bash
# 单笔交易走完整链路（调试用，公共 RPC 也能跑）
NODE_USE_ENV_PROXY=1 node --import tsx scripts/fetch-once.ts <signature>

# 采样某程序真实日志，发现发币特征串
NODE_USE_ENV_PROXY=1 node --import tsx scripts/watch-logs.ts 25

# 实测某个特征串的命中精度（避免瞎猜）
NODE_USE_ENV_PROXY=1 node --import tsx scripts/probe-creation.ts "Instruction: Create" 8

# M3 回填：对已跟踪代币快照一次市场数据（需联网）
npm run backfill
# 离线查看候选的首→末涨跌统计
npm run backfill:report
```

实测结论见 `docs/04-数据与工具链.md` 第 8 节。

## 7. 安全声明

本系统是**只读**的：不含私钥、不签名、不下单。所有真实交易仍由人手动在终端完成。
meme 币是**极高风险**资产，绝大多数会归零。本项目所有内容仅用于个人研究与娱乐，**不构成投资建议**，不保证任何结果。加密资产交易在部分地区（包括中国大陆）受到严格限制，使用者需自行确认所在地法律与合规义务。详见 `docs/08-风险与合规.md`。
