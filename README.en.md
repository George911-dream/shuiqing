# ShuiQing (税擎)

> **Tax knowledge-base search + AI Q&A (RAG) workbench**
>
> Zero-dependency, single-process, ready to run: drop your Markdown tax documents into a folder and get full-text search, category browsing, and DeepSeek-powered Q&A.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

[中文文档](./README.md) · English

---

## Features

- **Zero dependencies** — the backend uses only Node.js built-in modules. No `npm install` required after `git clone`.
- **Full-text search** — Chinese keywords, policy document numbers (e.g. `国家税务总局公告2026年第19号`), company names or stock codes; filter by category and tax type.
- **Category browsing** — a tree navigation that mirrors your folder structure.
- **AI Q&A (RAG)** — retrieves relevant evidence first, then asks DeepSeek to summarize. Answers are **streamed**, with `[1][2]` citations that link back to the source document.
- **Local-first** — the API key lives only in your browser (localStorage); it is never written to disk and only forwarded to the official DeepSeek API.
- **Lightweight index** — an inverted index over Chinese bigrams plus latin/number tokens; tens of thousands of documents are searchable in milliseconds.

## Requirements

- **Node.js ≥ 18** (verified on Node 22).
- A [DeepSeek API Key](https://platform.deepseek.com) for the AI Q&A feature (search/browse need no key).

## Quick start

```bash
# 1. Get the code
git clone <your-repo-url> shuiqing
cd shuiqing

# 2. Provide your documents (either way)
#    a) put Markdown files under ./data ; or
#    b) point to an existing directory
#       Linux/macOS:  KB_DIR=/path/to/docs node server.js
#       Windows:      set KB_DIR=D:\docs && node server.js

# 3. Start
node server.js        # or: npm start

# 4. Open http://127.0.0.1:8787
```

The first launch scans and builds the index (about 10–30 s for tens of thousands of documents).

Windows users can also double-click `start.cmd`.

## Document format

Documents are split by **level-2 Markdown headings**: each `## ` section becomes one document. An optional metadata line at the end is separated by `｜`:

```markdown
## 1. Announcement on VAT year-end retained tax credit refunds

(body…)

> Source: MOF ｜ No.: Announcement 2026 No.X ｜ Date: 2026-01-01 ｜ Status: in force ｜ Region: national ｜ Tax: VAT ｜ URL: https://...
```

- If a file has no `## ` heading, the whole file is treated as a single document.
- Metadata fields are optional; common ones (`Source/No./Date/Status/Region/Tax/URL`) are recognized for display and ranking.
- Recommended layout: `category / tax-type / file.md` — the workbench builds the navigation tree from it.

## Configuration (environment variables)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8787` | Listening port |
| `HOST` | `127.0.0.1` | Bind address (local only by default) |
| `KB_DIR` | `./data` if present, else parent dir | Directory to index |
| `KB_EXCLUDE` | empty | Extra folder names to skip (comma-separated) |
| `DEEPSEEK_API_KEY` | empty | Server-side default key (optional) |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | API endpoint (proxy/gateway friendly) |
| `DEEPSEEK_MODEL` | `deepseek-chat` | Default model |

## HTTP API

| Method | Path | Description |
|---|---|---|
| GET | `/api/meta` | Category tree, doc count, token count |
| GET | `/api/search?q=&category=&taxType=&limit=` | Search; browse by category when `q` is empty |
| GET | `/api/doc?id=` | Full document |
| POST | `/api/ask` | AI Q&A (RAG); SSE when `stream:true` |
| GET | `/api/health` | Health check |

## How it works

1. **Parse** — recursively read `.md`, split by `## `, parse the trailing metadata line.
2. **Index** — build an inverted index over "title + body + doc number + tax type + source + region" using Chinese **bigrams** plus latin/number tokens.
3. **Search** — TF-IDF scoring + title boost + exact phrase boost + exact doc-number boost.
4. **Q&A** — take the top-ranked documents as context, send them with a system prompt to DeepSeek, and stream back the answer with citations.

## Project structure

```
.
├─ server.js          # backend: scan / index / search / RAG API
├─ start.cmd          # Windows launcher
├─ package.json
├─ LICENSE
├─ .gitignore
├─ public/
│  ├─ index.html      # frontend
│  ├─ styles.css
│  └─ app.js
└─ data/              # your knowledge base (not version-controlled)
```

## Security & privacy

- The directory pointed to by `KB_DIR` is **not committed** (see `.gitignore`).
- The API key is not persisted by default; even with `DEEPSEEK_API_KEY` it only lives in the process environment.
- The server listens on `127.0.0.1` only. If you need LAN access, add your own authentication and access controls.

## Disclaimer

This project only performs **retrieval and summarization**. Output is based solely on your source files and **does not constitute tax, legal, or investment advice**. For any concrete tax matter, refer to the competent tax authority and official publications.

## License

The code is released under the [MIT License](./LICENSE). Note: the **document content** of your knowledge base is not covered by this license — make sure you have the right to use and publish the sources you index.

## Contributing

Issues and PRs are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md).
