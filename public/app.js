const state = {
  config: null,
  db: {},
  activeTab: '',
  batchNo: ''
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value = '') {
  return String(value ?? '')
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
  setTimeout(() => el.classList.remove('show'), 2200);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error(body.error || '请求失败'), { body });
  }
  if (res.status === 204) return null;
  return res.json();
}

function makeBatchNo() {
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const rand = Math.random().toString(16).slice(2, 7).toUpperCase();
  return `B${day}-${rand}`;
}

function valueByPath(source, pathName) {
  return pathName.split('.').reduce((value, key) => value?.[key], source);
}

function collectionLabel(collection) {
  return state.config.collections[collection]?.label || collection;
}

function relationLabel(relation, id) {
  const item = state.db[relation.collection]?.find((entry) => entry.id === id);
  if (!item) return '未关联';
  return relation.labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
}

function equipmentLabel(id) {
  const item = state.db.equipment?.find((entry) => entry.id === id);
  return item ? `${item.code} ${item.name}` : (id || '');
}

function optionList(items, labelFields) {
  return items.map((item) => {
    const label = labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
    return `<option value="${item.id}">${escapeHtml(label)}</option>`;
  }).join('');
}

function formField(field) {
  const required = field.required ? 'required' : '';
  const valueAttr = field.default !== undefined ? `value="${escapeHtml(field.default)}"` : '';
  if (field.type === 'textarea') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<textarea name="${field.name}" ${required}></textarea></label>`;
  }
  if (field.type === 'select') {
    const options = field.options.map((option) =>
      `<option value="${escapeHtml(option)}"${option === field.default ? ' selected' : ''}>${escapeHtml(option)}</option>`
    ).join('');
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${options}</select></label>`;
  }
  if (field.type === 'relation') {
    const items = state.db[field.collection] || [];
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${optionList(items, field.labelFields)}</select></label>`;
  }
  return `<label class="${field.wide ? 'wide' : ''}">${field.label}<input type="${field.type || 'text'}" name="${field.name}" ${valueAttr} ${required}></label>`;
}

function pill(value, tone = '') {
  return `<span class="pill ${tone}">${escapeHtml(value || '-')}</span>`;
}

function toneFor(value) {
  return state.config.tones?.[value] || '';
}

function occupancyPill(kind, id) {
  const occ = state.db.occupancy?.[kind]?.[id];
  if (!occ) return '';
  return `<span class="pill ${toneFor(occ.status)}" title="${escapeHtml(occ.detail)}">${escapeHtml(occ.status)}</span>`;
}

function historyHtml(item) {
  const history = item.history || [];
  if (!history.length) return '';
  return `<div class="history">${history.slice(0, 5).map((entry) => `
    <div class="history-item"><span>${fmtDate(entry.at)}</span><span>${escapeHtml(entry.action)}${entry.note ? '：' + escapeHtml(entry.note) : ''}</span></div>
  `).join('')}</div>`;
}

function values(form, view) {
  const payload = Object.fromEntries(new FormData(form).entries());
  for (const field of view.fields) {
    if (field.type === 'number') payload[field.name] = Number(payload[field.name] || 0);
  }
  return { ...view.defaults, ...payload };
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
    const value = stat.filter
      ? items.filter((item) => item[stat.filter.field] === stat.filter.value).length
      : items.length;
    return `<div class="stat"><span>${escapeHtml(stat.label)}</span><strong>${value}</strong></div>`;
  }).join('')}</div>`;
}

function availableActions(collection, item) {
  return state.config.actions.filter((action) => {
    if (action.collection !== collection) return false;
    if (action.id === 'survey-start') return item.stage === '未开始' && !item.draft;
    if (action.id === 'survey-complete') return item.stage === '进行中';
    if (collection === 'surveys' && item.stage === '已完成') return ['survey-alert', 'survey-review'].includes(action.id);
    if (collection === 'surveys' && (item.draft || item.stage === '停测')) return false;
    return true;
  });
}

function renderCard(item, collection, view) {
  const title = view.titleFields.map((field) => item[field]).filter(Boolean).join(' / ') || item.id;
  const relation = view.relation ? `<div class="meta">${escapeHtml(relationLabel(view.relation, item[view.relation.localKey]))}</div>` : '';
  const details = (view.detailFields || []).map((field) => {
    const raw = item[field.name];
    let value = raw ?? '-';
    if (field.type === 'relation') value = field.collection === 'equipment' ? equipmentLabel(raw) : relationLabel(field, raw);
    return `<div>${escapeHtml(field.label)}<br><strong>${escapeHtml(value || '-')}</strong></div>`;
  }).join('');
  const summary = (view.summaryFields || []).map((field) => item[field]).filter(Boolean).join(' · ');
  const actions = availableActions(collection, item)
    .map((action) => `<button class="${action.danger ? 'danger' : 'ghost'}" data-action="${action.id}" data-id="${item.id}">${escapeHtml(action.label)}</button>`)
    .join('');

  const occPill = occupancyPill(collection === 'sites' ? 'siteStatus' : 'surveyStatus', item.id);
  const envPill = collection === 'surveys' && item.status && item.status !== '正常'
    ? pill(item.status, toneFor(item.status))
    : '';
  const conflict = item.draft && item.conflictReason
    ? `<div class="conflict">冲突：${escapeHtml(item.conflictReason)}</div>`
    : '';
  const snapshot = collection === 'surveys' && item.snapshot
    ? `<div class="snapshot" title="完成时冻结，后续校准/等级变更不改写">
        现场快照（${fmtDate(item.snapshot.completedAt)}）：控制线 ${escapeHtml(item.snapshot.co2ControlLine)} ppm ·
        校准 ${escapeHtml(item.snapshot.co2Calibration)} · 等级 ${escapeHtml(item.snapshot.protectedStatus)}
       </div>`
    : '';
  const basis = collection === 'surveys' && item.basis && item.stage !== '已完成'
    ? `<div class="meta">重算依据：控制线 ${escapeHtml(item.basis.co2ControlLine)} ppm（基准 ${escapeHtml(item.basis.baselineCo2)} + 校准 ${escapeHtml(item.basis.co2Calibration)}），已重算 ${Number(item.basis.recalcCount) || 0} 次${item.basis.recalcReason ? '，原因：' + escapeHtml(item.basis.recalcReason) : ''}</div>`
    : '';
  const siteMeta = collection === 'sites'
    ? `<div class="meta">${escapeHtml(state.db.occupancy?.siteStatus?.[item.id]?.detail || '')}</div>`
    : '';

  return `<article class="card">
    <div class="card-head"><h3>${escapeHtml(title)}</h3><span class="pills">${occPill}${envPill}</span></div>
    ${relation}
    ${siteMeta}
    ${conflict}
    ${summary ? `<p>${escapeHtml(summary)}</p>` : ''}
    ${details ? `<div class="detail">${details}</div>` : ''}
    ${basis}
    ${snapshot}
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

// ---- 看板：设备配额 + 日期/时段占用格 + 批次状态，样点与巡测共用同一派生结果 ----
function renderQuotaBar(occ) {
  const quota = occ.quota;
  return `<div class="quota-bar">
    <span>今日洞内设备：<strong>${occ.todayCaveUsed}/${quota.caveKitsPerDay}</strong> 份</span>
    <span>冲突草稿：<strong>${occ.draftCount}</strong> 条</span>
    <span>停测排期：<strong>${occ.suspendedCount}</strong> 条</span>
    <span class="muted">规则：每天限带 ${quota.caveKitsPerDay} 份设备入洞；同队员/同设备/同样点同时段唯一</span>
  </div>`;
}

function statusChipFor(cell) {
  const tone = toneFor(cell.status);
  return `<span class="chip ${tone} ${cell.draft ? 'draft' : ''} ${cell.stage === '停测' ? 'suspended' : ''}"
    title="${escapeHtml(cell.conflictReason || `${cell.site} · ${cell.location} · ${cell.equipmentCode}`)}">
    <strong>${escapeHtml(cell.surveyor)}</strong>
    ${escapeHtml(cell.site.split(' / ').slice(-1)[0] || '')}
    <em>${escapeHtml(cell.location === '洞内' ? '洞·' + (cell.equipmentCode || '') : '洞外')}</em>
    <i>${escapeHtml(cell.status)}</i>
  </span>`;
}

function renderBoard(occ) {
  if (!occ.board.length) return '<div class="empty">暂无排期，请在左侧提交批次</div>';
  return occ.board.map((day) => `
    <div class="board-day ${day.caveFull ? 'full' : ''}">
      <div class="board-day-head">
        <strong>${escapeHtml(day.date)}</strong>
        <span class="${day.caveFull ? 'bad-text' : ''}">洞内 ${day.caveUsed}/${day.caveQuota} 份</span>
        ${day.drafts ? `<span class="warn-text">草稿 ${day.drafts}</span>` : ''}
        ${day.suspended ? `<span class="bad-text">停测 ${day.suspended}</span>` : ''}
      </div>
      <div class="board-slots">
        ${day.slots.map((row) => `
          <div class="board-slot">
            <span class="slot-name">${escapeHtml(row.slot)}</span>
            <div class="chips">${row.items.length ? row.items.map(statusChipFor).join('') : '<span class="muted">—</span>'}</div>
          </div>`).join('')}
      </div>
    </div>`).join('');
}

function renderBatches(occ) {
  if (!occ.batches.length) return '<div class="empty">暂无批次</div>';
  return occ.batches.map((batch) => `
    <div class="batch-row">
      <div>
        <strong>${escapeHtml(batch.batchNo)}</strong>
        ${pill(batch.state, toneFor(batch.state))}
        <span class="muted">到达序号 #${batch.arrivalSeq} · 共 ${batch.total} 条 · 占用 ${batch.occupied} · 草稿 ${batch.drafted} · 停测 ${batch.suspended}</span>
      </div>
      <div class="batch-btns">
        ${batch.drafted ? `<button class="ghost" data-retry-batch="${escapeHtml(batch.batchNo)}">按批次号重试</button>` : ''}
      </div>
    </div>`).join('');
}

function renderDashboardView(view) {
  const occ = state.db.occupancy;
  const source = view.focus;
  let items = [...(state.db[source.collection] || [])];
  if (source.field) items = items.filter((item) => source.values.includes(item[source.field]));
  items = items.slice(0, source.limit || 8);
  const cardView = state.config.views.find((entry) => entry.collection === source.collection) || source;
  return `<section class="view active" id="${view.id}">
    ${renderStats()}
    <div class="panel"><h2>占用状态（样点 / 巡测 / 看板同源）</h2>${renderQuotaBar(occ)}<div class="board">${renderBoard(occ)}</div></div>
    <div class="panel" style="margin-top:18px"><h2>${escapeHtml(view.focusTitle)}</h2><div class="list">${items.length ? items.map((item) => renderCard(item, source.collection, cardView)).join('') : '<div class="empty">暂无重点事项</div>'}</div></div>
  </section>`;
}

// ---- 排期批次视图 ----
const ROW_FIELDS = [
  { name: 'siteId', type: 'relation', collection: 'sites', labelFields: ['cave', 'zone', 'pointCode'] },
  { name: 'surveyor', placeholder: '队员' },
  { name: 'date', type: 'date' },
  { name: 'slot', type: 'select', options: ['上午', '下午', '夜间'] },
  { name: 'location', type: 'select', options: ['洞内', '洞外'] },
  { name: 'equipmentId', type: 'relation', collection: 'equipment', labelFields: ['code', 'name'] }
];

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function scheduleRow(index) {
  const fields = ROW_FIELDS.map((field) => {
    if (field.type === 'relation') {
      const items = state.db[field.collection] || [];
      return `<select data-row-field="${field.name}">${optionList(items, field.labelFields)}</select>`;
    }
    if (field.type === 'select') {
      return `<select data-row-field="${field.name}">${field.options.map((op) => `<option>${op}</option>`).join('')}</select>`;
    }
    const value = field.type === 'date' ? `value="${todayStr()}"` : '';
    return `<input type="${field.type || 'text'}" data-row-field="${field.name}" placeholder="${field.placeholder || ''}" ${value}>`;
  }).join('');
  return `<div class="sched-row" data-row="${index}"><span class="row-no">${index + 1}</span>${fields}<button type="button" class="ghost icon" data-remove-row title="移除本行">×</button></div>`;
}

function renderScheduleView() {
  const occ = state.db.occupancy;
  if (!state.batchNo) state.batchNo = makeBatchNo();
  return `<section class="view" id="schedule">
    <div class="grid schedule-grid">
      <form class="panel" id="batchForm">
        <h2>提交排期批次</h2>
        <p class="muted">两人同时提交同一时段时，服务端按到达顺序裁决：先到占用，后到整批保留草稿。写入失败可用同一批次号重试，不会重复建单。</p>
        <label>批次号（幂等键，写入失败后按此号重试）<input name="batchNo" value="${escapeHtml(state.batchNo)}" readonly></label>
        <label>备注<input name="note" placeholder="例如：西线两组联排"></label>
        <div id="rows">${scheduleRow(0)}${scheduleRow(1)}</div>
        <div class="actions">
          <button type="button" class="ghost" id="addRow">+ 加一条</button>
          <button type="submit">提交批次</button>
        </div>
      </form>
      <div class="panel">
        <h2>恢复批次 / 冲突草稿</h2>
        ${renderQuotaBar(occ)}
        <div class="batches">${renderBatches(occ)}</div>
      </div>
    </div>
    <div class="panel" style="margin-top:18px">
      <h2>排期看板</h2>
      <div class="board">${renderBoard(occ)}</div>
    </div>
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

function render() {
  $('#title').textContent = state.config.title;
  document.title = state.config.title;
  $('#lede').textContent = state.config.lede;
  $('#main').innerHTML = state.config.views.map((view) => {
    if (view.type === 'dashboard') return renderDashboardView(view);
    if (view.type === 'schedule') return renderScheduleView(view);
    return renderCrudView(view);
  }).join('');
  setTab(state.activeTab || state.config.views[0].id);
}

async function load() {
  state.db = await api('/api/db');
  render();
}

function collectBatchEntries(form) {
  return $$('.sched-row', form).map((row) => {
    const entry = {};
    $$('[data-row-field]', row).forEach((input) => { entry[input.dataset.rowField] = input.value; });
    return entry;
  }).filter((entry) => entry.siteId && entry.surveyor && entry.date && entry.slot);
}

async function submitBatch(form, batchNo) {
  const entries = collectBatchEntries(form);
  if (!entries.length) throw new Error('请至少填写一条完整排期（样点/队员/日期/时段）');
  const note = form.note?.value || '';
  return api('/api/schedule/batches', {
    method: 'POST',
    body: JSON.stringify({ batchNo, note, entries })
  });
}

function describeBatch(result) {
  const b = result.batch;
  const parts = [`批次 ${b.state}`];
  if (b.occupied) parts.push(`占用 ${b.occupied} 条`);
  if (b.drafted) parts.push(`草稿 ${b.drafted} 条（冲突已保留，可改时段后重试）`);
  if (b.suspended) parts.push(`停测 ${b.suspended} 条`);
  return parts.join('，');
}

document.addEventListener('click', async (event) => {
  const tab = event.target.closest('.tab');
  const action = event.target.closest('[data-action]');
  const addRow = event.target.closest('#addRow');
  const removeRow = event.target.closest('[data-remove-row]');
  const retryBatch = event.target.closest('[data-retry-batch]');

  if (tab) { setTab(tab.dataset.tab); return; }

  if (addRow) {
    const rows = $('#rows');
    rows.insertAdjacentHTML('beforeend', scheduleRow(rows.children.length));
    return;
  }
  if (removeRow) {
    const rows = $('#rows');
    if (rows.children.length > 1) removeRow.closest('.sched-row').remove();
    $$('.sched-row', rows).forEach((row, index) => { $('.row-no', row).textContent = index + 1; });
    return;
  }

  if (retryBatch) {
    // 可恢复：同批次号重试，冲突草稿可在表单里改时段后随批次号一起重提
    state.batchNo = retryBatch.dataset.retryBatch;
    setTab('schedule');
    const input = $('#batchForm [name="batchNo"]');
    if (input) input.value = state.batchNo;
    toast(`已载入批次号 ${state.batchNo}，调整冲突行后再次提交`);
    return;
  }

  if (action) {
    try {
      await api(`/api/action/${action.dataset.action}/${action.dataset.id}`, { method: 'POST' });
      await load();
      toast('已更新');
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
  const batchForm = event.target.closest('#batchForm');
  const form = event.target.closest('[data-create]');
  if (!batchForm && !form) return;
  event.preventDefault();

  try {
    if (batchForm) {
      const batchNo = batchForm.batchNo.value;
      const result = await submitBatch(batchForm, batchNo);
      // 提交后换新批次号；同号保留在批次卡片中可恢复
      state.batchNo = makeBatchNo();
      await load();
      toast(describeBatch(result));
      return;
    }
    const view = state.config.views.find((entry) => entry.id === form.dataset.view);
    await api(`/api/${form.dataset.create}`, { method: 'POST', body: JSON.stringify(values(form, view)) });
    form.reset();
    await load();
    toast('已保存');
  } catch (error) {
    // 写入失败：批次号保留在表单里，直接再次提交即按批次号重试
    toast(error.body?.retryable ? `写入失败，已保留批次号，请重试：${error.message}` : error.message);
  }
});

$('#refreshBtn').addEventListener('click', () => load().then(() => toast('已刷新')));

async function boot() {
  state.config = await api('/api/config');
  renderTabs();
  await load();
}

boot().catch((error) => toast(error.message));
