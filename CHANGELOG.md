# Changelog

本项目所有值得记录的变更都会写入本文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)。

## [Unreleased]

## [0.1.0] - 2026-10-03

### Added

- 只读采集链路（M0–M2）：订阅 pump.fun 新建代币事件、去重、补齐链上元数据。
- 代币补齐（enricher）：mint / freeze authority、持币分布、LP 与流动性。
- 评分与筛选（screener）：安全类硬性规则 + 质量类维度评分，输出 `pass` / `manual` / `reject`。
- 新币宽限期（`screening.freshGraceSec`）：发现初期天然缺失的质量维度降级为 `manual` 人工复核，
  安全类规则不受影响。
- 推送（notifier）：Telegram 或 stdout。
- 落库（store）：本地 SQLite。
- M3 市场数据回填（backfill）：定时快照 + 首→末涨跌统计报告。
- 代理支持（proxy）：适配本机 HTTP / SOCKS 代理。
- 调试脚本：`dry-run`、`fetch-once`、`watch-logs`、`probe-creation`。
- 文档：`docs/01` – `docs/09`。
- 离线单元测试 27 项。

### Fixed

- 公共 RPC 将 `getProgramAccounts` 静默降级为空集，导致持币数被误记为 0 并误杀全部候选。
  改为按供给量不变量判为 `unknown`，对应候选进入人工复核（详见 `docs/04` 第 8.6 节）。

[Unreleased]: https://github.com/weinotes/meme-lab/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/weinotes/meme-lab/releases/tag/v0.1.0
