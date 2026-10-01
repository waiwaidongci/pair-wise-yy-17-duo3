const state = {
  config: null,
  db: {},
  activeTab: ''
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function fmtDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1800);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || '请求失败');
  }
  if (res.status === 204) return null;
  return res.json();
}

function valueByPath(source, pathName) {
  return pathName.split('.').reduce((value, key) => value?.[key], source);
}

function displayField(item, field) {
  const value = item[field.name] ?? '';
  if (field.type === 'select' && field.options) return value || field.options[0];
  return value;
}

function collectionLabel(collection) {
  return state.config.collections[collection]?.label || collection;
}

function relationLabel(relation, id) {
  const item = state.db[relation.collection]?.find((entry) => entry.id === id);
  if (!item) return '未关联';
  return relation.labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
}

function optionList(items, labelFields) {
  return items.map((item) => {
    const label = labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
    return `<option value="${item.id}">${escapeHtml(label)}</option>`;
  }).join('');
}

function formField(field) {
  const required = field.required ? 'required' : '';
  const value = field.default ? `value="${escapeHtml(field.default)}"` : '';
  if (field.type === 'textarea') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<textarea name="${field.name}" ${required}></textarea></label>`;
  }
  if (field.type === 'select') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${field.options.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}</select></label>`;
  }
  if (field.type === 'relation') {
    const items = state.db[field.collection] || [];
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${optionList(items, field.labelFields)}</select></label>`;
  }
  return `<label class="${field.wide ? 'wide' : ''}">${field.label}<input type="${field.type || 'text'}" name="${field.name}" ${value} ${required}></label>`;
}

function pill(value, tone = '') {
  return `<span class="pill ${tone}">${escapeHtml(value || '-')}</span>`;
}

function toneFor(value) {
  return state.config.tones?.[value] || '';
}

function historyHtml(item) {
  const history = item.history || [];
  if (!history.length) return '';
  return `<div class="history">${history.slice(0, 5).map((entry) => `
    <div class="history-item"><span>${fmtDate(entry.at)}</span><span>${escapeHtml(entry.action)}${entry.note ? '：' + escapeHtml(entry.note) : ''}</span></div>
  `).join('')}</div>`;
}

function sortNewest(a, b) {
  return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
}

function values(form, view) {
  const payload = Object.fromEntries(new FormData(form).entries());
  for (const field of view.fields) {
    if (field.type === 'number') payload[field.name] = Number(payload[field.name] || 0);
  }
  return { ...view.defaults, ...payload };
}

// 批次提交：同一批次号幂等，冲突保留草稿，失败后提示去批次记录重试
async function submitBatch(form, view) {
  const batchId = `batch-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const payload = values(form, view);
  try {
    const res = await api('/api/batches', {
      method: 'POST',
      body: JSON.stringify({ batchId, items: [{ collection: view.collection, op: 'create', payload }] })
    });
    form.reset();
    await load();
    const drafts = (res.results || []).filter((entry) => entry.status === 'draft');
    if (drafts.length) {
      toast(`时段冲突，已保留草稿：${drafts[0].message || ''}`);
    } else {
      toast('已保存');
    }
  } catch (error) {
    await load();
    toast(`写入失败：${error.message}，可在批次记录中按批次号重试`);
  }
}

function renderTabs() {
  $('#tabs').innerHTML = state.config.views.map((view, index) => `
    <button class="tab${index === 0 ? ' active' : ''}" data-tab="${view.id}">${escapeHtml(view.label)}</button>
  `).join('');
  state.activeTab = state.config.views[0].id;
}

function setTab(tabId) {
  state.activeTab = tabId;
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === tabId));
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === tabId));
}

function renderStats() {
  return `<div class="stats">${state.config.stats.map((stat) => {
    const items = state.db[stat.collection] || [];
    const value = stat.filter ? items.filter((item) => item[stat.filter.field] === stat.filter.value).length : items.length;
    return `<div class="stat"><span>${escapeHtml(stat.label)}</span><strong>${value}</strong></div>`;
  }).join('')}</div>`;
}

function surveyExtras(item) {
  const bits = [];
  if (item.status === '草稿' && item.conflict) {
    bits.push(`<div class="notice conflict">冲突未占用：${escapeHtml((item.conflict.messages || []).join('；'))}</div>`);
  }
  if (item.status === '已失效') {
    bits.push(`<div class="notice invalid">已失效：${escapeHtml(item.invalidReason || '基准变更')}，已按新基准重算${item.expectedBaseline ? `（基准CO2 ${escapeHtml(item.expectedBaseline.baselineCo2)}）` : ''}</div>`);
  }
  if (item.snapshot) {
    bits.push(`<div class="notice snapshot">现场快照：基准CO2 ${escapeHtml(item.snapshot.baselineCo2)} / 保护等级 ${escapeHtml(item.snapshot.protectedStatus)}（${fmtDate(item.snapshot.capturedAt)}）</div>`);
  }
  return bits.join('');
}

function occupancyHtml(item, view) {
  if (!view.occupancy) return '';
  const occ = view.occupancy;
  const rows = (state.db[occ.collection] || [])
    .filter((entry) => entry[occ.foreignKey] === item.id && occ.statuses.includes(entry.status))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.slot).localeCompare(String(b.slot))
      || String(a.surveyor).localeCompare(String(b.surveyor)));
  if (!rows.length) return '<div class="occ empty">近期无排期占用</div>';
  return `<div class="occ"><h4>占用排期（${rows.length}）</h4><div class="occ-rows">${rows.map((row) =>
    `<span class="occ-chip">${occ.fields.map((field) => escapeHtml(row[field] || '-')).join(' · ')}</span>`
  ).join('')}</div></div>`;
}

function renderCard(item, collection, view) {
  const title = view.titleFields.map((field) => item[field]).filter(Boolean).join(' / ') || item.id;
  const statusValue = item[view.statusField];
  const relation = view.relation ? `<div class="meta">${escapeHtml(relationLabel(view.relation, item[view.relation.localKey]))}</div>` : '';
  const details = (view.detailFields || []).map((field) => {
    const raw = item[field.name];
    const value = field.type === 'relation' ? relationLabel(field, raw) : raw;
    return `<div>${escapeHtml(field.label)}<br><strong>${escapeHtml(value || '-')}</strong></div>`;
  }).join('');
  const summary = (view.summaryFields || []).map((field) => item[field]).filter(Boolean).join(' · ');
  const extras = collection === 'surveys' ? surveyExtras(item) : occupancyHtml(item, view);
  const actions = state.config.actions
    .filter((action) => action.collection === collection)
    .map((action) => `<button class="${action.danger ? 'danger' : 'ghost'}" data-action="${action.id}" data-id="${item.id}">${escapeHtml(action.label)}</button>`)
    .join('');
  return `<article class="card">
    <div class="card-head"><h3>${escapeHtml(title)}</h3>${statusValue ? pill(statusValue, toneFor(statusValue)) : ''}</div>
    ${relation}
    ${summary ? `<p>${escapeHtml(summary)}</p>` : ''}
    ${details ? `<div class="detail">${details}</div>` : ''}
    ${extras}
    ${actions ? `<div class="actions">${actions}</div>` : ''}
    ${historyHtml(item)}
  </article>`;
}

function renderList(view) {
  const collection = view.collection;
  const query = $(`#search-${view.id}`)?.value.trim() || '';
  const status = $(`#status-${view.id}`)?.value || '';
  let items = [...(state.db[collection] || [])];
  if (query) {
    items = items.filter((item) => view.searchFields.some((field) => String(item[field] || '').includes(query)));
  }
  if (status) {
    items = items.filter((item) => item[view.statusField] === status);
  }
  return items.length ? items.map((item) => renderCard(item, collection, view)).join('') : `<div class="empty">暂无${escapeHtml(collectionLabel(collection))}</div>`;
}

function renderDashboardView(view) {
  const source = view.focus;
  let items = [...(state.db[source.collection] || [])];
  if (source.field) items = items.filter((item) => source.values.includes(item[source.field]));
  items = items.slice(0, source.limit || 8);
  const cardView = state.config.views.find((entry) => entry.collection === source.collection) || source;
  return `<section class="view active" id="${view.id}">
    ${renderStats()}
    <div class="panel"><h2>${escapeHtml(view.focusTitle)}</h2><div class="list">${items.length ? items.map((item) => renderCard(item, source.collection, cardView)).join('') : '<div class="empty">暂无重点事项</div>'}</div></div>
  </section>`;
}

function renderCrudView(view) {
  const statusOptions = view.statusOptions || [];
  return `<section class="view" id="${view.id}">
    <div class="grid">
      <form class="panel" data-create="${view.collection}" data-view="${view.id}">
        <h2>${escapeHtml(view.formTitle)}</h2>
        <div class="form-grid">${view.fields.map(formField).join('')}</div>
        <div class="actions"><button>${escapeHtml(view.submitLabel || '保存')}</button></div>
      </form>
      <div class="panel">
        <h2>${escapeHtml(view.listTitle)}</h2>
        <div class="toolbar">
          <input id="search-${view.id}" placeholder="${escapeHtml(view.searchPlaceholder || '搜索')}">
          <select id="status-${view.id}">
            <option value="">全部状态</option>
            ${statusOptions.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}
          </select>
        </div>
        <div class="list" id="list-${view.id}">${renderList(view)}</div>
      </div>
    </div>
  </section>`;
}

function renderBatchesView(view) {
  const batches = [...(state.db.batches || [])].sort(sortNewest);
  return `<section class="view" id="${view.id}">
    ${renderStats()}
    <div class="panel">
      <h2>批次记录</h2>
      ${batches.length ? `<table class="batches"><thead><tr><th>批次号</th><th>状态</th><th>条目</th><th>结果</th><th>更新时间</th><th></th></tr></thead><tbody>
        ${batches.map((batch) => {
          const applied = batch.results.filter((entry) => entry.status === 'applied').length;
          const drafts = batch.results.filter((entry) => entry.status === 'draft').length;
          const errors = batch.results.filter((entry) => entry.status === 'error').length;
          const statusLabel = batch.status === 'committed' ? '已提交' : batch.status === 'failed' ? '失败' : '处理中';
          const statusTone = batch.status === 'committed' ? 'ok' : batch.status === 'failed' ? 'bad' : 'warn';
          return `<tr>
            <td class="mono">${escapeHtml(batch.id)}</td>
            <td>${pill(statusLabel, statusTone)}</td>
            <td>${batch.items.length}</td>
            <td class="batch-result">应用 ${applied} · 草稿 ${drafts}${errors ? ` · 失败 ${errors}` : ''}</td>
            <td>${fmtDate(batch.updatedAt)}</td>
            <td>${batch.status === 'failed' || batch.status === 'pending' ? `<button class="ghost" data-retry="${escapeHtml(batch.id)}">重试</button>` : ''}</td>
          </tr>`;
        }).join('')}
      </tbody></table>` : '<div class="empty">暂无批次</div>'}
    </div>
  </section>`;
}

function render() {
  $('#title').textContent = state.config.title;
  document.title = state.config.title;
  $('#lede').textContent = state.config.lede;
  $('#main').innerHTML = state.config.views.map((view) => {
    if (view.type === 'dashboard') return renderDashboardView(view);
    if (view.type === 'batches') return renderBatchesView(view);
    return renderCrudView(view);
  }).join('');
  setTab(state.activeTab || state.config.views[0].id);
}

async function load() {
  state.db = await api('/api/db');
  render();
}

document.addEventListener('click', async (event) => {
  const tab = event.target.closest('.tab');
  const action = event.target.closest('[data-action]');
  const retry = event.target.closest('[data-retry]');
  if (tab) setTab(tab.dataset.tab);
  if (action) {
    try {
      await api(`/api/action/${action.dataset.action}/${action.dataset.id}`, { method: 'POST' });
      await load();
      toast('已更新');
    } catch (error) {
      toast(error.message);
    }
  }
  if (retry) {
    try {
      const res = await api(`/api/batches/${retry.dataset.retry}/retry`, { method: 'POST' });
      await load();
      toast(res.status === 'committed' ? '批次已重试' : '批次仍有失败条目');
    } catch (error) {
      toast(error.message);
    }
  }
});

document.addEventListener('input', (event) => {
  const view = state.config.views.find((entry) => entry.id && (event.target.id === `search-${entry.id}` || event.target.id === `status-${entry.id}`));
  if (view) $(`#list-${view.id}`).innerHTML = renderList(view);
});

document.addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-create]');
  if (!form) return;
  event.preventDefault();
  const view = state.config.views.find((entry) => entry.id === form.dataset.view);
  if (view.batch) return submitBatch(form, view);
  await api(`/api/${form.dataset.create}`, { method: 'POST', body: JSON.stringify(values(form, view)) });
  form.reset();
  await load();
  toast('已保存');
});

$('#refreshBtn').addEventListener('click', () => load().then(() => toast('已刷新')));

async function boot() {
  state.config = await api('/api/config');
  renderTabs();
  await load();
}

boot().catch((error) => toast(error.message));
