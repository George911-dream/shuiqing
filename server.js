'use strict';

/*
 * 税擎 (ShuiQing) · 税务知识库工作台 — 后端服务
 * 零依赖 Node.js 服务：扫描知识库 → 建立检索索引 → 提供检索 / 浏览 / AI 问答（RAG）接口。
 *
 * 数据目录解析顺序：
 *   1) 环境变量 KB_DIR
 *   2) 本目录下 ./data（若存在）
 *   3) 本目录的上一级目录
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const WORKDIR = __dirname;
const PUBLIC_DIR = path.join(WORKDIR, 'public');

function resolveDataDir() {
  if (process.env.KB_DIR) return path.resolve(process.env.KB_DIR);
  const local = path.join(WORKDIR, 'data');
  if (fs.existsSync(local)) return local;
  return path.resolve(WORKDIR, '..');
}
const DATA_DIR = resolveDataDir();
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const DEEPSEEK_BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const DEFAULT_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const EXCLUDE_NAMES = new Set(['node_modules', '.git', '.cache', path.basename(WORKDIR)]
  .concat(process.env.KB_EXCLUDE ? process.env.KB_EXCLUDE.split(',').map(s => s.trim()).filter(Boolean) : []));

// ---------------------------------------------------------------------------
// 文档模型
// ---------------------------------------------------------------------------

const docs = [];          // 全部文档
const index = new Map();  // 正文倒排索引：token -> number[]（docId）
const titleIndex = new Map(); // 标题倒排索引
let stats = null;

function isCJK(ch) {
  return ch >= '\u4e00' && ch <= '\u9fff';
}

function tokenize(text) {
  const set = new Set();
  const clean = text.replace(/\s+/g, '');
  for (let i = 0; i + 1 < clean.length; i++) {
    if (isCJK(clean[i])) set.add(clean.slice(i, i + 2));
  }
  const words = text.toLowerCase().match(/[a-z0-9]{2,}/g);
  if (words) for (const w of words) set.add(w);
  return set;
}

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  for (const e of entries) {
    if (EXCLUDE_NAMES.has(e.name)) continue;
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(p, out);
    } else if (e.name.toLowerCase().endsWith('.md') && !/^readme\.md$/i.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

function categoryLabel(name) {
  return name.replace(/^\d+[-_、.]/, '').replace(/^\d+\s*/, '');
}

function parseMeta(line) {
  const meta = {};
  if (!line) return meta;
  const body = line.replace(/^>+\s*/, '');
  const segs = body.split(/[｜|]/);
  for (const seg of segs) {
    const idx = seg.indexOf('：');
    const idx2 = idx >= 0 ? idx : seg.indexOf(':');
    if (idx2 < 0) continue;
    const k = seg.slice(0, idx2).trim();
    const v = seg.slice(idx2 + 1).trim();
    if (k) meta[k] = v;
  }
  return meta;
}

function recordDoc(relPath, parts, docNo, title, body, meta) {
  const category = parts[0] || '';
  const taxType = parts.length >= 3 ? parts[1] : '全部';
  const id = docs.length;
  const doc = {
    id,
    category,
    categoryLabel: categoryLabel(category),
    taxType,
    part: path.basename(relPath, '.md'),
    relPath,
    docNo,
    title: title || '(无标题)',
    body: body || '',
    source: meta['来源'] || '',
    docNumber: meta['文号'] || '',
    date: meta['日期'] || '',
    effect: meta['效力'] || '',
    region: meta['地区'] || '',
    topics: meta['税种/业务'] || '',
    url: meta['原文'] || ''
  };
  doc.titleLower = doc.title.toLowerCase();
  doc.docNumberLower = doc.docNumber.toLowerCase();
  doc.hay = (doc.title + '\n' + doc.body + '\n' +
    [doc.docNumber, doc.topics, doc.source, doc.region].join(' ')).toLowerCase();
  docs.push(doc);
  return doc;
}

function addToIndex(map, token, id) {
  let arr = map.get(token);
  if (!arr) { arr = []; map.set(token, arr); }
  arr.push(id);
}

function parseMarkdownFile(filePath) {
  const rel = path.relative(DATA_DIR, filePath);
  const parts = rel.split(/[\\/]/);
  const fileName = parts[parts.length - 1];
  parts[parts.length - 1] = fileName.replace(/\.md$/i, '');
  const raw = fs.readFileSync(filePath, 'utf8');

  if (!/^## /m.test(raw)) {
    // 目录 / 清单类文件：整篇作为一个文档
    const m = raw.match(/^#\s+(.+)/m);
    const title = m ? m[1].trim() : fileName;
    recordDoc(rel, parts, 1, title, raw.trim(), {});
    return;
  }

  const chunks = raw.split(/^## /m);
  chunks.shift(); // 文件头
  let seq = 0;
  for (const chunk of chunks) {
    seq++;
    const lines = chunk.split(/\r?\n/);
    let title = (lines[0] || '').trim();
    let docNo = seq;
    const tm = title.match(/^(\d+)\s*[.．、]\s*(.*)$/);
    if (tm) { docNo = Number(tm[1]); title = tm[2].trim(); }

    let bodyLines = lines.slice(1);
    let meta = {};
    for (let i = bodyLines.length - 1; i >= 0; i--) {
      const l = bodyLines[i].trim();
      if (!l) continue;
      if (l.startsWith('>')) {
        meta = parseMeta(l);
        bodyLines = bodyLines.slice(0, i);
      }
      break;
    }
    const body = bodyLines.join('\n').trim();
    recordDoc(rel, parts, docNo, title, body, meta);
  }
}

function buildIndex() {
  const t0 = Date.now();
  const files = walk(DATA_DIR, []);
  process.stdout.write(`[workbench] 扫描目录：${DATA_DIR}\n`);
  process.stdout.write(`[workbench] 发现 ${files.length} 个 Markdown 文件，正在解析…\n`);
  for (const f of files) {
    try {
      parseMarkdownFile(f);
    } catch (e) {
      process.stderr.write(`[workbench] 解析失败：${f} — ${e.message}\n`);
    }
  }
  process.stdout.write(`[workbench] 共 ${docs.length} 篇文档，正在建立索引…\n`);
  for (const doc of docs) {
    const tokens = tokenize(doc.hay);
    for (const tk of tokens) addToIndex(index, tk, doc.id);
    for (const tk of tokenize(doc.title)) addToIndex(titleIndex, tk, doc.id);
  }
  buildStats();
  process.stdout.write(`[workbench] 索引完成：${index.size} 个词元，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
}

function buildStats() {
  const catMap = new Map();
  let dated = 0;
  for (const d of docs) {
    if (d.date && /^\d{4}/.test(d.date)) dated++;
    if (!catMap.has(d.category)) {
      catMap.set(d.category, { name: d.category, label: d.categoryLabel, count: 0, taxTypes: new Map() });
    }
    const c = catMap.get(d.category);
    c.count++;
    c.taxTypes.set(d.taxType, (c.taxTypes.get(d.taxType) || 0) + 1);
  }
  const categories = [...catMap.values()].map(c => ({
    name: c.name,
    label: c.label,
    count: c.count,
    taxTypes: [...c.taxTypes.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
  }));
  stats = {
    total: docs.length,
    categories,
    tokens: index.size,
    dataDir: DATA_DIR,
    updated: new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
// 检索
// ---------------------------------------------------------------------------

function queryTokens(q) {
  return [...tokenize(q)];
}

function toResult(d, score, snippet) {
  return {
    id: d.id,
    title: d.title,
    category: d.category,
    categoryLabel: d.categoryLabel,
    taxType: d.taxType,
    date: d.date,
    source: d.source,
    docNumber: d.docNumber,
    effect: d.effect,
    region: d.region,
    topics: d.topics,
    snippet: snippet,
    score: score == null ? undefined : Number(score.toFixed(3))
  };
}

function matchFilter(d, category, taxType) {
  if (category && d.category !== category) return false;
  if (taxType && d.taxType !== taxType) return false;
  return true;
}

function scoreDocs(q, opts) {
  const { category, taxType, limit = 50 } = opts || {};
  const tokens = queryTokens(q);
  const raw = q.replace(/\s+/g, '');
  const N = docs.length;
  const scores = new Map();

  for (const tk of tokens) {
    const post = index.get(tk);
    if (!post) continue;
    const idf = Math.log(1 + N / post.length);
    for (let i = 0; i < post.length; i++) {
      scores.set(post[i], (scores.get(post[i]) || 0) + idf);
    }
    const tpost = titleIndex.get(tk);
    if (tpost) {
      const bidf = idf * 3;
      for (let i = 0; i < tpost.length; i++) {
        scores.set(tpost[i], (scores.get(tpost[i]) || 0) + bidf);
      }
    }
  }

  // 完整短语精确加权：文号、专有名词、长关键词
  const rawLower = raw.toLowerCase();
  if (rawLower.length >= 1) {
    for (let id = 0; id < docs.length; id++) {
      const d = docs[id];
      if (!matchFilter(d, category, taxType)) continue;
      let add = 0;
      if (d.docNumberLower && d.docNumberLower.indexOf(rawLower) >= 0) add += 30;
      if (d.titleLower.indexOf(rawLower) >= 0) add += 12 + rawLower.length;
      else if (d.hay.indexOf(rawLower) >= 0) add += 5 + rawLower.length * 0.5;
      if (add) scores.set(id, (scores.get(id) || 0) + add);
    }
  }

  const candidates = [];
  for (const [id, sc] of scores) {
    if (!matchFilter(docs[id], category, taxType)) continue;
    candidates.push([id, sc]);
  }
  candidates.sort((a, b) => b[1] - a[1]);

  const results = candidates.slice(0, limit).map(([id, sc]) =>
    toResult(docs[id], sc, makeSnippet(docs[id].body, raw, tokens)));
  return { total: candidates.length, results, tokens };
}

function listDocs(category, taxType, limit) {
  const matched = [];
  for (const d of docs) {
    if (matchFilter(d, category, taxType)) matched.push(d);
  }
  matched.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  return {
    total: matched.length,
    results: matched.slice(0, limit).map(d => toResult(d, null, clamp(d.body, 200)))
  };
}

function makeSnippet(body, raw, tokens) {
  if (!body) return '';
  let pos = -1, len = 0;
  if (raw && raw.length >= 2) {
    const p = body.indexOf(raw);
    if (p >= 0) { pos = p; len = raw.length; }
  }
  if (pos < 0) {
    const sorted = [...tokens].sort((a, b) => b.length - a.length);
    for (const t of sorted) {
      const i = body.indexOf(t);
      if (i >= 0) { pos = i; len = t.length; break; }
    }
  }
  if (pos < 0) return clamp(body.slice(0, 180));
  const start = Math.max(0, pos - 70);
  const end = Math.min(body.length, pos + len + 130);
  return (start > 0 ? '…' : '') + body.slice(start, end).replace(/\s+/g, ' ') + (end < body.length ? '…' : '');
}

function clamp(s, n = 180) {
  s = (s || '').replace(/\s+/g, ' ');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// ---------------------------------------------------------------------------
// DeepSeek RAG
// ---------------------------------------------------------------------------

function buildMessages(question, sources, history) {
  const lines = sources.map((d, i) => {
    const meta = [
      `分类：${d.categoryLabel} / ${d.taxType}`,
      d.date ? `日期：${d.date}` : '',
      d.docNumber ? `文号：${d.docNumber}` : '',
      d.effect ? `效力：${d.effect}` : '',
      d.source ? `来源：${d.source}` : ''
    ].filter(Boolean).join(' ｜ ');
    const body = d.body.length > 1600 ? d.body.slice(0, 1600) + '…' : d.body;
    return `【资料${i + 1}】${d.title}\n${meta}\n正文：${body}`;
  }).join('\n\n---\n\n');

  const system = [
    '你是「税务知识库智能助手」，基于提供的资料回答中国税务问题。',
    '要求：',
    '1. 只依据【资料】内容作答，不得编造或引入资料之外的政策与数据。',
    '2. 资料不足时，明确说明「现有资料未涵盖」，并给出可进一步查询的方向。',
    '3. 引用依据时，用 [1][2] 形式标注对应的资料编号。',
    '4. 涉及具体政策时，尽量给出文号、发布日期、适用条件与地区。',
    '5. 使用简体中文，条理清晰，可用要点或分条列举。',
    '6. 涉及专业判断或个案，提示以主管税务机关及官方发布为准。'
  ].join('\n');

  const messages = [{ role: 'system', content: system }];
  if (Array.isArray(history)) {
    for (const m of history.slice(-6)) {
      if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') continue;
      messages.push({ role: m.role, content: m.content.slice(0, 4000) });
    }
  }
  messages.push({
    role: 'user',
    content: `【资料开始】\n${lines || '（未检索到相关资料）'}\n【资料结束】\n\n用户问题：${question}`
  });
  return messages;
}

async function callDeepSeek({ apiKey, model, messages, stream }) {
  const res = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      messages,
      temperature: 0.2,
      stream: !!stream
    })
  });
  return res;
}

async function handleAsk(req, res) {
  let payload;
  try {
    payload = await readJson(req);
  } catch (e) {
    return sendJson(res, 400, { error: '请求体解析失败：' + e.message });
  }
  const question = (payload && payload.question ? String(payload.question) : '').trim();
  if (!question) return sendJson(res, 400, { error: '缺少 question' });

  const apiKey = (payload.apiKey || process.env.DEEPSEEK_API_KEY || '').trim();
  const model = (payload.model || DEFAULT_MODEL).trim();
  const topK = Math.min(Math.max(Number(payload.topK) || 8, 1), 20);

  const { results } = scoreDocs(question, { limit: topK });
  const sources = results.map(r => docs[r.id]);

  if (!apiKey) {
    return sendJson(res, 200, {
      answer: '（未配置 DeepSeek API Key，无法生成 AI 回答。请在页面右上角填写 API Key 后重试。）',
      sources: results,
      model,
      noKey: true
    });
  }

  const wantStream = payload.stream !== false;
  const messages = buildMessages(question, sources, payload.history);

  if (!wantStream) {
    try {
      const r = await callDeepSeek({ apiKey, model, messages, stream: false });
      const data = await r.json();
      if (!r.ok) {
        return sendJson(res, r.status, { error: data.error && data.error.message || ('DeepSeek 返回 ' + r.status), sources: results });
      }
      const answer = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '';
      return sendJson(res, 200, { answer, sources: results, model, usage: data.usage });
    } catch (e) {
      return sendJson(res, 502, { error: '调用 DeepSeek 失败：' + e.message, sources: results });
    }
  }

  // 流式 SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  const sse = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
  sse({ type: 'sources', sources: results, model });

  try {
    const r = await callDeepSeek({ apiKey, model, messages, stream: true });
    if (!r.ok) {
      let msg = 'DeepSeek 返回 ' + r.status;
      try { const j = await r.json(); if (j.error && j.error.message) msg = j.error.message; } catch (_) {}
      sse({ type: 'error', error: msg });
      sse({ type: 'done' });
      return res.end();
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n');
      buffer = parts.pop();
      for (const line of parts) {
        const t = line.trim();
        if (!t || !t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
          if (delta) sse({ type: 'delta', text: delta });
        } catch (_) {}
      }
    }
    sse({ type: 'done' });
    res.end();
  } catch (e) {
    sse({ type: 'error', error: '调用 DeepSeek 失败：' + e.message });
    sse({ type: 'done' });
    res.end();
  }
}

// ---------------------------------------------------------------------------
// HTTP 基础设施
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[\\/])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsed.pathname;

    try {
      if (pathname === '/api/health') {
        return sendJson(res, 200, { ok: true, total: docs.length, updated: stats && stats.updated });
      }
      if (pathname === '/api/meta') {
        return sendJson(res, 200, stats || { total: docs.length, categories: [] });
      }
      if (pathname === '/api/search') {
        const q = (parsed.searchParams.get('q') || '').trim();
        const category = parsed.searchParams.get('category') || '';
        const taxType = parsed.searchParams.get('taxType') || '';
        const limit = Math.min(Math.max(Number(parsed.searchParams.get('limit')) || 30, 1), 100);
        const t0 = Date.now();
        let out;
        if (!q) {
          if (!category && !taxType) return sendJson(res, 200, { total: 0, results: [], tokens: [] });
          out = listDocs(category, taxType, limit);
          out.tokens = [];
        } else {
          out = scoreDocs(q, { category, taxType, limit });
        }
        out.took = Date.now() - t0;
        return sendJson(res, 200, out);
      }
      if (pathname === '/api/doc') {
        const id = Number(parsed.searchParams.get('id'));
        if (!Number.isInteger(id) || id < 0 || id >= docs.length) return sendJson(res, 404, { error: 'not found' });
        return sendJson(res, 200, docs[id]);
      }
      if (pathname === '/api/ask' && req.method === 'POST') {
        return await handleAsk(req, res);
      }
      if (pathname.startsWith('/api/')) {
        return sendJson(res, 404, { error: 'unknown api' });
      }
      return serveStatic(req, res, pathname);
    } catch (e) {
      if (!res.headersSent) sendJson(res, 500, { error: e.message });
      else res.end();
    }
  });
}

// ---------------------------------------------------------------------------

function main() {
  if (!fs.existsSync(DATA_DIR)) {
    console.error(`[workbench] 知识库目录不存在：${DATA_DIR}`);
    process.exit(1);
  }
  buildIndex();
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log('');
    console.log('  税擎 (ShuiQing) · 税务知识库工作台');
    console.log('  ────────────────────────────────────────────');
    console.log(`   文档总数 : ${docs.length}`);
    console.log(`   词元总数 : ${index.size}`);
    console.log(`   知识库   : ${DATA_DIR}`);
    console.log(`   访问地址 : http://${HOST}:${PORT}`);
    console.log('');
    console.log('   按 Ctrl+C 停止服务');
    console.log('');
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`[workbench] 端口 ${PORT} 已被占用，请设置 PORT 环境变量后重试。`);
    else console.error('[workbench] 服务错误：', e);
    process.exit(1);
  });
}

main();
