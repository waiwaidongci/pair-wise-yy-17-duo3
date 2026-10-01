const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const app = express();
const config = require('./project.config');
const PORT = process.env.PORT || config.port || 3900;
const DB_FILE = path.join(__dirname, 'data', 'db.json');

// 巡测队排期约束：每个时段最多两台设备进洞
const DEVICE_CAPACITY = 2;
// 占用时段的状态；草稿不占设备，已失效不再占用
const ACTIVE_STATUSES = ['已排期'];
const COMPLETED_STATUSES = ['正常', '异常待复查', '已复查'];
const NOT_STARTED_STATUSES = ['已排期', '草稿'];

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

async function readDb() {
  const raw = await fs.readFile(DB_FILE, 'utf8');
  return JSON.parse(raw);
}

async function writeDb(db) {
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2) + '\n');
}

// 原子写入：先落临时文件再改名，避免写失败留下半截数据
async function writeDbAtomic(db) {
  const tmp = `${DB_FILE}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(db, null, 2) + '\n');
  await fs.rename(tmp, DB_FILE);
}

function stamp(action, note) {
  return {
    at: new Date().toISOString(),
    action,
    note: note || ''
  };
}

function sortNewest(a, b) {
  return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
}

function newId(collection) {
  return `${collection}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
}

// 现场快照：已完成巡测保留当时的样点基准，之后基准变化不影响历史记录
function siteSnapshot(site = {}) {
  return {
    baselineTemp: site.baselineTemp ?? null,
    baselineHumidity: site.baselineHumidity ?? null,
    baselineCo2: site.baselineCo2 ?? null,
    protectedStatus: site.protectedStatus ?? null,
    capturedAt: new Date().toISOString()
  };
}

// 排期冲突检测：队员、设备、时段排重，设备容量上限，保护等级停测
function findConflicts(db, survey) {
  const conflicts = [];
  const site = db.sites.find((entry) => entry.id === survey.siteId);
  if (site && site.protectedStatus === '暂停开放') {
    conflicts.push({ type: 'site-closed', message: `样点 ${site.pointCode || site.id} 已暂停开放，禁止排期` });
  }
  const others = db.surveys.filter((entry) =>
    entry.id !== survey.id &&
    entry.date === survey.date &&
    entry.slot === survey.slot &&
    ACTIVE_STATUSES.includes(entry.status)
  );
  if (survey.surveyor && others.some((entry) => entry.surveyor === survey.surveyor)) {
    conflicts.push({ type: 'surveyor', message: `${survey.date} ${survey.slot}：队员 ${survey.surveyor} 已有巡测任务` });
  }
  if (survey.equipment && others.some((entry) => entry.equipment === survey.equipment)) {
    conflicts.push({ type: 'equipment', message: `${survey.date} ${survey.slot}：${survey.equipment} 已被占用` });
  }
  if (others.length + 1 > DEVICE_CAPACITY) {
    conflicts.push({ type: 'capacity', message: `${survey.date} ${survey.slot}：设备已满（每时段限 ${DEVICE_CAPACITY} 台设备进洞）` });
  }
  return conflicts;
}

// 新建巡测：无冲突则占用时段，有冲突则保留草稿（不占设备）
function createSurvey(db, payload) {
  const now = new Date().toISOString();
  const survey = {
    id: newId('survey'),
    siteId: payload.siteId || '',
    surveyor: payload.surveyor || '',
    date: payload.date || '',
    slot: payload.slot || '上午',
    equipment: payload.equipment || '',
    temperature: payload.temperature ?? null,
    humidity: payload.humidity ?? null,
    co2: payload.co2 ?? null,
    dripRate: payload.dripRate ?? null,
    disturbance: payload.disturbance || '',
    photoUrl: payload.photoUrl || '',
    status: payload.status || '已排期',
    reviewNote: payload.reviewNote || '',
    createdAt: now,
    updatedAt: now,
    history: [stamp('创建', '排期登记')]
  };
  const conflicts = findConflicts(db, survey);
  if (conflicts.length) {
    survey.status = '草稿';
    survey.conflict = {
      at: now,
      types: conflicts.map((entry) => entry.type),
      messages: conflicts.map((entry) => entry.message)
    };
    survey.history.unshift(stamp('冲突草稿', conflicts.map((entry) => entry.message).join('；')));
  } else {
    survey.snapshot = siteSnapshot(db.sites.find((entry) => entry.id === survey.siteId));
    survey.history.unshift(stamp('排期确认', `${survey.date} ${survey.slot} ${survey.equipment}`.trim()));
  }
  db.surveys.push(survey);
  return { survey, conflicts };
}

// 改期：排期字段变化后重新检测冲突，冲突则降为草稿
function updateSurvey(db, survey, payload) {
  const schedulingFields = ['siteId', 'surveyor', 'date', 'slot', 'equipment'];
  const schedulingChanged = schedulingFields.some((field) => payload[field] !== undefined && payload[field] !== survey[field]);
  const historyAction = payload.historyAction;
  delete payload.historyAction;
  Object.assign(survey, payload, { updatedAt: new Date().toISOString() });
  if (schedulingChanged && !COMPLETED_STATUSES.includes(survey.status)) {
    const conflicts = findConflicts(db, survey);
    survey.history = survey.history || [];
    if (conflicts.length) {
      survey.status = '草稿';
      survey.conflict = {
        at: new Date().toISOString(),
        types: conflicts.map((entry) => entry.type),
        messages: conflicts.map((entry) => entry.message)
      };
      survey.history.unshift(stamp('冲突草稿', conflicts.map((entry) => entry.message).join('；')));
    } else {
      survey.status = '已排期';
      delete survey.conflict;
      survey.history.unshift(stamp('排期确认', `${survey.date} ${survey.slot} ${survey.equipment}`.trim()));
    }
  } else if (historyAction || payload.note || payload.memo) {
    survey.history = survey.history || [];
    survey.history.unshift(stamp(historyAction || '更新', payload.note || payload.memo || ''));
  }
  return survey;
}

// 样点基准变更：未开始的巡测立即失效并按新基准重算，已完成的保留现场快照
function applySiteChange(db, site, payload) {
  const before = {
    baselineCo2: site.baselineCo2,
    protectedStatus: site.protectedStatus,
    baselineTemp: site.baselineTemp,
    baselineHumidity: site.baselineHumidity
  };
  const historyAction = payload.historyAction;
  delete payload.historyAction;
  Object.assign(site, payload, { updatedAt: new Date().toISOString() });
  const changedCo2 = payload.baselineCo2 !== undefined && payload.baselineCo2 !== before.baselineCo2;
  const changedLevel = payload.protectedStatus !== undefined && payload.protectedStatus !== before.protectedStatus;
  site.history = site.history || [];
  if (changedCo2 || changedLevel) {
    const reason = changedLevel ? '保护等级变更' : 'CO2校准值变更';
    const affected = db.surveys.filter((entry) => entry.siteId === site.id && NOT_STARTED_STATUSES.includes(entry.status));
    for (const survey of affected) {
      survey.status = '已失效';
      survey.invalidReason = reason;
      survey.expectedBaseline = {
        baselineTemp: site.baselineTemp,
        baselineHumidity: site.baselineHumidity,
        baselineCo2: site.baselineCo2,
        protectedStatus: site.protectedStatus
      };
      survey.updatedAt = new Date().toISOString();
      survey.history.unshift(stamp('失效重算', `${reason}，排期作废并按新基准重算`));
    }
    for (const survey of db.surveys.filter((entry) => entry.siteId === site.id && COMPLETED_STATUSES.includes(entry.status))) {
      if (!survey.snapshot) {
        survey.snapshot = siteSnapshot(site);
        survey.updatedAt = new Date().toISOString();
      }
    }
    site.history.unshift(stamp(reason, `${affected.length} 条未开始巡测已失效重算`));
  } else {
    site.history.unshift(stamp(historyAction || '更新', payload.note || payload.memo || ''));
  }
  return site;
}

// 批次串行队列：并发提交时先到者占用时段，后到者读到冲突并保留草稿
let batchQueue = Promise.resolve();
function enqueueBatch(task) {
  const run = batchQueue.then(task, task);
  batchQueue = run.then(() => undefined, () => undefined);
  return run;
}

function normalizeItem(item, index) {
  return {
    itemKey: item.itemKey || `${index}`,
    collection: item.collection,
    op: item.op || 'create',
    id: item.id || null,
    payload: item.payload || {}
  };
}

function applyBatchItem(db, item) {
  if (item.collection === 'surveys' && item.op === 'create') {
    return { kind: 'survey', ...createSurvey(db, item.payload) };
  }
  if (item.collection === 'surveys' && item.op === 'update') {
    const survey = db.surveys.find((entry) => entry.id === item.id);
    if (!survey) throw new Error('巡测记录不存在');
    const before = survey.status;
    updateSurvey(db, survey, item.payload);
    return {
      kind: 'survey',
      survey,
      conflicts: survey.status === '草稿' && before !== '草稿'
        ? (survey.conflict?.messages || []).map((message) => ({ message }))
        : []
    };
  }
  if (item.collection === 'sites' && item.op === 'update') {
    const site = db.sites.find((entry) => entry.id === item.id);
    if (!site) throw new Error('样点不存在');
    return { kind: 'site', site: applySiteChange(db, site, item.payload), conflicts: [] };
  }
  throw new Error(`不支持的批次项: ${item.collection} / ${item.op}`);
}

// 批次处理：按 batchId 幂等，已提交的批次重放结果，失败的批次跳过已应用项后重试
async function processBatch(batchId, items, existingDb) {
  const db = existingDb || await readDb();
  db.batches = db.batches || [];
  let batch = db.batches.find((entry) => entry.id === batchId);
  if (batch && batch.status === 'committed') return { batch, db, replayed: true };
  if (!batch) {
    batch = {
      id: batchId,
      status: 'pending',
      items: items.map(normalizeItem),
      results: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    db.batches.push(batch);
  }
  const results = [];
  for (const [index, item] of batch.items.entries()) {
    const prior = batch.results.find((entry) => entry.itemKey === item.itemKey);
    if (prior && prior.status === 'applied') {
      results.push(prior);
      continue;
    }
    try {
      const outcome = applyBatchItem(db, item);
      const survey = outcome.survey || null;
      const isDraft = survey && survey.status === '草稿';
      results.push({
        itemKey: item.itemKey,
        status: isDraft ? 'draft' : 'applied',
        id: survey?.id || outcome.site?.id || null,
        message: outcome.conflicts?.length ? outcome.conflicts.map((entry) => entry.message).join('；') : ''
      });
    } catch (error) {
      results.push({ itemKey: item.itemKey, status: 'error', error: error.message });
    }
  }
  batch.results = results;
  batch.status = results.some((entry) => entry.status === 'error') ? 'failed' : 'committed';
  batch.updatedAt = new Date().toISOString();
  await writeDbAtomic(db);
  return { batch, db, replayed: false };
}

app.get('/api/config', (req, res) => {
  res.json(config);
});

app.get('/api/db', async (req, res) => {
  const db = await readDb();
  for (const key of Object.keys(db)) {
    if (Array.isArray(db[key])) db[key].sort(sortNewest);
  }
  res.json(db);
});

// 批次提交：同一 batchId 幂等，写失败后可凭批次号重试
app.post('/api/batches', async (req, res) => {
  const { batchId, items } = req.body || {};
  if (!batchId || typeof batchId !== 'string' || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: '需要 batchId 与 items' });
  }
  try {
    const outcome = await enqueueBatch(() => processBatch(batchId, items));
    const hasDraft = outcome.batch.results.some((entry) => entry.status === 'draft');
    res.status(outcome.replayed ? 200 : hasDraft ? 207 : 200).json({
      batchId: outcome.batch.id,
      status: outcome.batch.status,
      results: outcome.batch.results,
      replayed: outcome.replayed
    });
  } catch (error) {
    res.status(500).json({ error: error.message, batchId, retryable: true });
  }
});

app.get('/api/batches', async (req, res) => {
  const db = await readDb();
  res.json((db.batches || []).sort(sortNewest));
});

// 失败批次重试：沿用原批次号，已应用的条目不会重复写入
app.post('/api/batches/:id/retry', async (req, res) => {
  try {
    const outcome = await enqueueBatch(async () => {
      const db = await readDb();
      const existing = (db.batches || []).find((entry) => entry.id === req.params.id);
      if (!existing) {
        const error = new Error('批次不存在');
        error.status = 404;
        throw error;
      }
      return processBatch(existing.id, existing.items, db);
    });
    res.json({ batchId: outcome.batch.id, status: outcome.batch.status, results: outcome.batch.results });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message, retryable: true });
  }
});

app.post('/api/:collection', async (req, res) => {
  const db = await readDb();
  const { collection } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  if (collection === 'surveys') {
    const { survey, conflicts } = createSurvey(db, req.body);
    await writeDbAtomic(db);
    return res.status(conflicts.length ? 207 : 201).json(survey);
  }
  const now = new Date().toISOString();
  const item = {
    id: newId(collection),
    ...req.body,
    createdAt: now,
    updatedAt: now,
    history: [stamp('创建', req.body.note || req.body.memo || '')]
  };
  db[collection].push(item);
  await writeDbAtomic(db);
  res.status(201).json(item);
});

app.patch('/api/:collection/:id', async (req, res) => {
  const db = await readDb();
  const { collection, id } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  const item = db[collection].find((entry) => entry.id === id);
  if (!item) return res.status(404).json({ error: 'not found' });
  if (collection === 'sites') {
    applySiteChange(db, item, req.body);
  } else if (collection === 'surveys') {
    updateSurvey(db, item, req.body);
  } else {
    const historyAction = req.body.historyAction;
    delete req.body.historyAction;
    Object.assign(item, req.body, { updatedAt: new Date().toISOString() });
    item.history = item.history || [];
    if (historyAction || req.body.note || req.body.memo || req.body.status) {
      item.history.unshift(stamp(historyAction || req.body.status || '更新', req.body.note || req.body.memo || ''));
    }
  }
  await writeDbAtomic(db);
  res.json(item);
});

app.delete('/api/:collection/:id', async (req, res) => {
  const db = await readDb();
  const { collection, id } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  const before = db[collection].length;
  db[collection] = db[collection].filter((entry) => entry.id !== id);
  if (db[collection].length === before) return res.status(404).json({ error: 'not found' });
  await writeDbAtomic(db);
  res.status(204).end();
});

app.post('/api/action/:actionId/:id', async (req, res) => {
  const db = await readDb();
  const action = config.actions.find((entry) => entry.id === req.params.actionId);
  if (!action) return res.status(404).json({ error: 'unknown action' });
  const item = db[action.collection]?.find((entry) => entry.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const result = runAction(db, action, item);
  if (result.error) return res.status(409).json({ error: result.error });
  await writeDbAtomic(db);
  res.json(result.item);
});

function getValue(source, pathName) {
  return pathName.split('.').reduce((value, key) => value?.[key], source);
}

function setValue(target, pathName, value) {
  const keys = pathName.split('.');
  let cursor = target;
  while (keys.length > 1) {
    const key = keys.shift();
    cursor[key] = cursor[key] || {};
    cursor = cursor[key];
  }
  cursor[keys[0]] = value;
}

function findRelated(db, relation, item) {
  return db[relation.collection]?.find((entry) => entry.id === item[relation.localKey]);
}

function runAction(db, action, item) {
  const related = action.relation ? findRelated(db, action.relation, item) : null;
  const context = { item, related };
  const levelRank = { '低': 1, '中': 2, '高': 3 };
  for (const guard of action.guards || []) {
    const left = getValue(context, guard.left);
    const right = guard.rightPath ? getValue(context, guard.rightPath) : guard.right;
    if (guard.op === 'missing' && left) continue;
    if (guard.op === 'missing' && !left) return { error: guard.message };
    if (guard.op === 'eq' && left !== right) return { error: guard.message };
    if (guard.op === 'neq' && left === right) return { error: guard.message };
    if (guard.op === 'gte' && Number(left) < Number(right)) return { error: guard.message };
    if (guard.op === 'levelGte' && (levelRank[left] || 0) < (levelRank[right] || 0)) return { error: guard.message };
    if (guard.op === 'notIn' && guard.values.includes(left)) return { error: guard.message };
  }
  for (const patch of action.patches || []) {
    const target = patch.target === 'related' ? related : item;
    if (!target) continue;
    const next = patch.valuePath ? getValue(context, patch.valuePath) : patch.value;
    setValue(target, patch.field, next);
    target.updatedAt = new Date().toISOString();
    target.history = target.history || [];
    target.history.unshift(stamp(action.label, action.note || '状态流转'));
  }
  // 巡测完成时固化现场快照，样点基准之后变化不再影响该记录
  if (action.collection === 'surveys' && COMPLETED_STATUSES.includes(item.status) && !item.snapshot) {
    item.snapshot = siteSnapshot(related || undefined);
  }
  for (const delta of action.deltas || []) {
    const target = delta.target === 'related' ? related : item;
    if (!target) continue;
    const sourceAmount = delta.amountPath ? Number(getValue(context, delta.amountPath)) : 1;
    const multiplier = delta.amount === undefined ? 1 : Number(delta.amount);
    const amount = sourceAmount * multiplier;
    const current = Number(getValue({ target }, `target.${delta.field}`) || 0);
    setValue(target, delta.field, current + amount);
    target.updatedAt = new Date().toISOString();
    target.history = target.history || [];
    target.history.unshift(stamp(action.label, action.note || '数量调整'));
  }
  return { item };
}

app.listen(PORT, () => {
  console.log(`${config.title} running at http://localhost:${PORT}`);
});
