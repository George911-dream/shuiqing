# 更新日志 / Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本。

## [1.0.0] - 2026-10-15

### 新增
- 零依赖 Node.js 后端（仅使用内置模块）：扫描 → 建索引 → 检索 → RAG。
- 中文二元组（bigram）+ 英文/数字分词的倒排索引；TF-IDF + 标题加权 + 整句短语/文号精确加权。
- 全库检索接口 `/api/search`，支持按分类、税种筛选；无关键词时按分类浏览。
- 单篇文档接口 `/api/doc`。
- 基于 DeepSeek 的 AI 问答接口 `/api/ask`，支持 SSE 流式输出与 `[1][2]` 引用来源。
- Web 工作台：检索、分类导航、文档查看、流式问答与引用跳转。
- 可移植的数据目录解析：`KB_DIR` → `./data` → 上一级目录。
- 环境变量配置：`PORT` / `HOST` / `KB_DIR` / `KB_EXCLUDE` / `DEEPSEEK_*`。
- 文档：中英文 README、架构图、贡献指南。
- MIT 开源许可。
