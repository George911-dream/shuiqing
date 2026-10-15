'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  filter: { category: '', taxType: '' },
  meta: null,
  chat: [] // {role, content}
};

// ---------- 通用 ----------
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function highlight(text, terms) {
  let html = escapeHtml(text);
  const list = (terms || []).filter(t => t && t.length >= 2).sort((a, b) => b.length - a.length).slice(0, 30);
  for (const t of list) {
    const re = new RegExp(escapeRegExp(escapeHtml(t)), 'g');
    html = html.replace(re, m => `<mark>${m}</mark>`);
  }
  return html;
}

async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// ---------- 初始化 ----------
async function init() {
  $('#apiKey').value = localStorage.getItem('shuiqing_api_key') || '';
  $('#modelSelect').value = localStorage.getItem('shuiqing_model') || 'deepseek-chat';
  bindEvents();
  try {
    const meta = await api('/api/meta');
    state.meta = meta;
    $('#statusLine').textContent = `已加载 ${meta.total.toLocaleString()} 篇文档 · ${meta.categories.length} 个分类 · 词元 ${meta.tokens ? meta.tokens.toLocaleString() : '-'}`;
    renderOverview(meta);
    renderTree(meta);
  } catch (e) {
    $('#statusLine').textContent = '知识库加载失败：' + e.message;
  }
}

function renderOverview(meta) {
  $('#overview').innerHTML = `
    <div class="big">${meta.total.toLocaleString()}</div>
    <div class="sub">篇知识文档</div>
    <div class="sub" style="margin-top:6px">${meta.categories.length} 个一级分类</div>`;
}

function renderTree(meta) {
  const tree = $('#tree');
  tree.innerHTML = '';
  for (const cat of meta.categories) {
    const el = document.createElement('div');
    el.className = 'cat';
    const sub = (cat.taxTypes.length === 1 && cat.taxTypes[0].name === '全部') ? '' : cat.taxTypes.map(t => `
          <div class="tax" data-cat="${escapeHtml(cat.name)}" data-tax="${escapeHtml(t.name)}">
            <span>${escapeHtml(t.name)}</span><span class="tc">${t.count.toLocaleString()}</span>
          </div>`).join('');
    el.innerHTML = `
      <div class="cat-head" data-cat="${escapeHtml(cat.name)}">
        <span>${escapeHtml(cat.label)}</span>
        <span class="count">${cat.count.toLocaleString()}</span>
      </div>
      <div class="taxes">${sub}</div>`;
    tree.appendChild(el);

    $('.cat-head', el).addEventListener('click', () => {
      el.classList.toggle('open');
      setFilter(cat.name, '');
    });
    $$('.tax', el).forEach(node => {
      node.addEventListener('click', (ev) => {
        ev.stopPropagation();
        setFilter(node.dataset.cat, node.dataset.tax);
      });
    });
  }
}

function setFilter(category, taxType) {
  state.filter = { category: category || '', taxType: taxType || '' };
  renderFilterChips();
  markActive();
  const q = $('#searchInput').value.trim();
  if (q || state.filter.category) runSearch();
  switchTab('search');
}

function renderFilterChips() {
  const box = $('#filterChips');
  const { category, taxType } = state.filter;
  if (!category) { box.innerHTML = ''; return; }
  const meta = state.meta;
  const cat = meta && meta.categories.find(c => c.name === category);
  const label = cat ? cat.label : category;
  box.innerHTML = `
    <span class="chip">${escapeHtml(label)}${taxType ? ' / ' + escapeHtml(taxType) : ''}
      <button title="清除" id="chipClear">×</button></span>`;
  $('#chipClear').addEventListener('click', () => setFilter('', ''));
}

function markActive() {
  $$('.cat-head').forEach(n => n.classList.toggle('active', n.dataset.cat === state.filter.category));
  $$('.tax').forEach(n => n.classList.toggle('active',
    n.dataset.cat === state.filter.category && n.dataset.tax === state.filter.taxType));
}

// ---------- 检索 ----------
async function runSearch() {
  const q = $('#searchInput').value.trim();
  const { category, taxType } = state.filter;
  if (!q && !category) { $('#results').innerHTML = ''; $('#searchMeta').textContent = ''; return; }
  $('#searchMeta').textContent = '检索中…';
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (category) params.set('category', category);
  if (taxType) params.set('taxType', taxType);
  params.set('limit', '40');
  try {
    const data = await api('/api/search?' + params.toString());
    $('#searchMeta').textContent = `命中约 ${data.total.toLocaleString()} 篇 · 用时 ${data.took}ms`;
    renderResults(data, q, category, taxType);
  } catch (e) {
    $('#searchMeta').textContent = '检索失败：' + e.message;
  }
}

function renderResults(data, q) {
  const box = $('#results');
  if (!data.results.length) {
    box.innerHTML = `<div class="empty">${q ? '未找到匹配文档，请更换关键词。' : '该分类下暂无文档。'}</div>`;
    return;
  }
  const terms = q ? (q.replace(/\s+/g, '').match(/[\u4e00-\u9fff]{2,}|[a-z0-9]{2,}/gi) || []) : [];
  const hl = new Set(terms);
  for (const t of terms) {
    if (/^[\u4e00-\u9fff]+$/.test(t)) {
      for (let i = 0; i + 1 < t.length; i++) hl.add(t.slice(i, i + 2));
    }
  }
  box.innerHTML = '';
  for (const r of data.results) {
    const el = document.createElement('article');
    el.className = 'result';
    el.innerHTML = `
      <div class="r-top">
        <h3>${escapeHtml(r.title)}</h3>
        <div class="badges">
          <span class="badge cat">${escapeHtml(r.categoryLabel)}${r.taxType && r.taxType !== '全部' ? ' · ' + escapeHtml(r.taxType) : ''}</span>
          ${r.date ? `<span class="badge date">${escapeHtml(r.date)}</span>` : ''}
        </div>
      </div>
      <div class="snippet">${highlight(r.snippet, [...hl])}</div>
      <div class="r-meta">
        ${r.docNumber ? `<span>文号：${escapeHtml(r.docNumber)}</span>` : ''}
        ${r.effect ? `<span>效力：${escapeHtml(r.effect)}</span>` : ''}
        ${r.source ? `<span>来源：${escapeHtml(r.source)}</span>` : ''}
        ${r.region ? `<span>地区：${escapeHtml(r.region)}</span>` : ''}
      </div>`;
    el.addEventListener('click', () => openDoc(r.id));
    box.appendChild(el);
  }
}

// ---------- 文档查看 ----------
async function openDoc(id) {
  const modal = $('#docModal');
  modal.classList.remove('hidden');
  $('#docTitle').textContent = '加载中…';
  $('#docContent').textContent = '';
  $('#docMeta').innerHTML = '';
  try {
    const d = await api('/api/doc?id=' + id);
    $('#docTitle').textContent = d.title;
    const bits = [
      `<span>${escapeHtml(d.categoryLabel)}${d.taxType && d.taxType !== '全部' ? ' / ' + escapeHtml(d.taxType) : ''}</span>`,
      d.docNumber ? `<span>文号：${escapeHtml(d.docNumber)}</span>` : '',
      d.date ? `<span>日期：${escapeHtml(d.date)}</span>` : '',
      d.effect ? `<span>效力：${escapeHtml(d.effect)}</span>` : '',
      d.region ? `<span>地区：${escapeHtml(d.region)}</span>` : '',
      d.source ? `<span>来源：${escapeHtml(d.source)}</span>` : ''
    ].filter(Boolean);
    $('#docMeta').innerHTML = bits.join('');
    let html = escapeHtml(d.body || '（无正文）');
    if (d.url) {
      html += `\n\n原文链接：<a href="${escapeHtml(d.url)}" target="_blank" rel="noopener">${escapeHtml(d.url)}</a>`;
    }
    $('#docContent').innerHTML = html;
  } catch (e) {
    $('#docTitle').textContent = '加载失败';
    $('#docContent').textContent = e.message;
  }
}

// ---------- AI 问答 ----------
function appendUser(text) {
  const chat = $('#chat');
  const el = document.createElement('div');
  el.className = 'msg user';
  el.innerHTML = `<div class="avatar">我</div><div class="bubble"><div class="content">${escapeHtml(text)}</div></div>`;
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
}

function appendBot() {
  const chat = $('#chat');
  const el = document.createElement('div');
  el.className = 'msg bot';
  el.innerHTML = `<div class="avatar">AI</div>
    <div class="bubble">
      <div class="content cursor"></div>
      <div class="src-list"></div>
    </div>`;
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
  return { content: $('.content', el), srcList: $('.src-list', el), el };
}

async function ask(question) {
  const key = $('#apiKey').value.trim();
  const model = $('#modelSelect').value;
  if (!question.trim()) return;
  const emptyEl = $('.chat-empty');
  if (emptyEl) emptyEl.remove();

  appendUser(question);
  state.chat.push({ role: 'user', content: question });
  const bot = appendBot();
  $('#askBtn').disabled = true;

  try {
    const resp = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question, apiKey: key, model, topK: 8, stream: true,
        history: state.chat.slice(-7, -1)
      })
    });

    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const j = await resp.json();
      bot.content.classList.remove('cursor');
      if (j.error) { bot.content.classList.add('error'); bot.content.textContent = '错误：' + j.error; }
      else { bot.content.textContent = j.answer || '（无内容）'; }
      if (j.sources) renderSources(bot.srcList, j.sources);
      state.chat.push({ role: 'assistant', content: bot.content.textContent });
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let text = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n');
      buffer = parts.pop();
      for (const line of parts) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        let evt;
        try { evt = JSON.parse(t.slice(5).trim()); } catch (_) { continue; }
        if (evt.type === 'sources') {
          renderSources(bot.srcList, evt.sources);
        } else if (evt.type === 'delta') {
          text += evt.text;
          bot.content.textContent = text;
          bot.content.classList.add('cursor');
          $('#chat').scrollTop = $('#chat').scrollHeight;
        } else if (evt.type === 'error') {
          bot.content.classList.add('error');
          bot.content.textContent = (text ? text + '\n\n' : '') + '错误：' + evt.error;
        }
      }
    }
    bot.content.classList.remove('cursor');
    if (!text) bot.content.textContent = '（未返回内容）';
    state.chat.push({ role: 'assistant', content: text || bot.content.textContent });
  } catch (e) {
    bot.content.classList.remove('cursor');
    bot.content.classList.add('error');
    bot.content.textContent = '请求失败：' + e.message;
  } finally {
    $('#askBtn').disabled = false;
  }
}

function renderSources(box, sources) {
  box.innerHTML = '';
  (sources || []).forEach((s, i) => {
    const chip = document.createElement('button');
    chip.className = 'src-chip';
    chip.title = s.title;
    chip.innerHTML = `<span class="n">[${i + 1}]</span>${escapeHtml(s.title)}`;
    chip.addEventListener('click', () => openDoc(s.id));
    box.appendChild(chip);
  });
}

// ---------- 事件 ----------
function switchTab(name) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  $('#panel-search').classList.toggle('active', name === 'search');
  $('#panel-ask').classList.toggle('active', name === 'ask');
}

function bindEvents() {
  $$('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  $('#searchBtn').addEventListener('click', runSearch);
  $('#searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); });

  $('#resetFilter').addEventListener('click', () => { state.filter = { category: '', taxType: '' }; renderFilterChips(); markActive(); });

  $('#closeModal').addEventListener('click', () => $('#docModal').classList.add('hidden'));
  $('.modal-backdrop').addEventListener('click', () => $('#docModal').classList.add('hidden'));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#docModal').classList.add('hidden'); });

  $('#apiKey').addEventListener('change', e => localStorage.setItem('shuiqing_api_key', e.target.value.trim()));
  $('#toggleKey').addEventListener('click', () => {
    const el = $('#apiKey');
    el.type = el.type === 'password' ? 'text' : 'password';
    $('#toggleKey').textContent = el.type === 'password' ? '显示' : '隐藏';
  });
  $('#modelSelect').addEventListener('change', e => localStorage.setItem('shuiqing_model', e.target.value));

  $('#askBtn').addEventListener('click', () => {
    const q = $('#questionInput').value;
    $('#questionInput').value = '';
    ask(q);
  });
  $('#questionInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const q = e.target.value;
      e.target.value = '';
      ask(q);
    }
  });
  $$('.sample').forEach(b => b.addEventListener('click', () => {
    switchTab('ask');
    ask(b.textContent.trim());
  }));
}

init();
