const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const app = express();
const config = require('./project.config');
const PORT = process.env.PORT || config.port || 3900;
const DB_FILE = process.env.SCHEDULE_DB
  ? path.resolve(process.env.SCHEDULE_DB)
  : path.join(__dirname, 'data', 'db.json');

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---- 存储层：全量读 + 临时文件原子写 ----
async function readDb() {
  const raw = await fs.readFile(DB_FILE, 'utf8');
  const db = JSON.parse(raw);
  db.equipment = db.equipment || [];
  db.batches = db.batches || [];
  return db;
}

async function writeDb(db) {
  const tmp = `${DB_FILE}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(db, null, 2) + '\n');
  await fs.rename(tmp, DB_FILE);
}

// ---- 串行化所有写操作：请求按到达顺序进入临界区，实现“先到先占” ----
let chain = Promise.resolve();
let arrivalCounter = 0;

function locked(handler) {
  return (req, res) => {
    const arrivalSeq = ++arrivalCounter;
    req.arrivalSeq = arrivalSeq;
    const run = chain.then(() => handler(req, res));
    chain = run.catch(() => {});
  };
}

function stamp(action, note) {
  return { at: new Date().toISOString(), action, note: note || '' };
}

function sortNewest(a, b) {
  return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
}

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

// ---- 排期领域规则 ----
const PLAN_STAGES = ['未开始', '进行中'];
const SLOTS = config.schedule.slots;
const LOCATIONS = config.schedule.locations;
const CAVE_QUOTA = config.schedule.caveKitQuotaPerDay;

function surveyorKey(item) {
  return `surveyor:${item.surveyor}|${item.date}|${item.slot}`;
}
function equipmentKey(item) {
  return `equipment:${item.equipmentId}|${item.date}|${item.slot}`;
}
function siteKey(item) {
  return `site:${item.siteId}|${item.date}|${item.slot}`;
}

function siteLabel(site) {
  return site ? [site.cave, site.zone, site.pointCode].filter(Boolean).join(' / ') : '未关联样点';
}

function basisFor(site) {
  return {
    protectedStatus: site.protectedStatus,
    baselineCo2: Number(site.baselineCo2) || 0,
    co2Calibration: Number(site.co2Calibration) || 0,
    co2ControlLine: (Number(site.baselineCo2) || 0) + (Number(site.co2Calibration) || 0),
    recalcCount: 0
  };
}

/**
 * 当前占用索引：只统计已占用（非草稿、未停测、未完成/进行中）的排期。
 * 进行中与未开始都占着人和设备；已完成释放资源，现场数据保留在快照里。
 */
function buildAdmissionIndex(db) {
  const surveyorMap = new Map();
  const equipmentMap = new Map();
  const siteMap = new Map();
  const caveCount = new Map();
  for (const item of db.surveys || []) {
    if (item.draft || item.stage === '停测' || item.stage === '已完成') continue;
    if (!PLAN_STAGES.includes(item.stage)) continue;
    if (item.location === '洞内') caveCount.set(item.date, (caveCount.get(item.date) || 0) + 1);
    surveyorMap.set(surveyorKey(item), item);
    if (item.equipmentId) equipmentMap.set(equipmentKey(item), item);
    siteMap.set(siteKey(item), item);
  }
  return { surveyorMap, equipmentMap, siteMap, caveCount };
}

/** 对一批新/待重试条目做占用仲裁：通过则占用，不通过则保留草稿并写明冲突原因 */
function admitEntries(db, entries) {
  const index = buildAdmissionIndex(db);
  const siteById = new Map((db.sites || []).map((site) => [site.id, site]));
  const equipmentById = new Map((db.equipment || []).map((equip) => [equip.id, equip]));
  const results = [];

  for (const item of entries) {
    // 只重新仲裁当前还是草稿的条目；已占用的（幂等重试时）原样保留
    if (!item.draft) {
      results.push({ item, ok: true });
      continue;
    }

    const site = siteById.get(item.siteId);
    const equip = item.equipmentId ? equipmentById.get(item.equipmentId) : null;
    const conflicts = [];

    if (!site) conflicts.push('样点不存在或已删除');
    if (item.equipmentId && !equip) conflicts.push('设备不存在或已删除');
    if (!item.surveyor || !item.date || !item.slot) conflicts.push('缺少人员、日期或时段');
    if (item.slot && !SLOTS.includes(item.slot)) conflicts.push(`时段必须是 ${SLOTS.join('/')}`);
    if (item.location && !LOCATIONS.includes(item.location)) conflicts.push(`位置必须是 ${LOCATIONS.join('/')}`);

    if (site && site.protectedStatus === '暂停开放') {
      // 保护等级决定停测：不占用任何资源
      item.draft = false;
      item.stage = '停测';
      item.conflictReason = '';
      item.basis = { ...basisFor(site), recalcCount: item.basis?.recalcCount || 0 };
      item.updatedAt = new Date().toISOString();
      item.history = item.history || [];
      item.history.unshift(stamp('停测', `样点 ${site.pointCode} 已暂停开放，排期停测并释放占用`));
      results.push({ item, ok: true, suspended: true });
      continue;
    }

    if (site) {
      const blocker = index.surveyorMap.get(surveyorKey(item));
      if (blocker) conflicts.push(`同队员${item.surveyor}在 ${item.date} ${item.slot} 已有排期（${blocker.id}）`);
      if (item.equipmentId) {
        const equipBlocker = index.equipmentMap.get(equipmentKey(item));
        if (equipBlocker) conflicts.push(`设备 ${equip.code || item.equipmentId} 同时段已被占用`);
      }
      const siteBlocker = index.siteMap.get(siteKey(item));
      if (siteBlocker) conflicts.push(`样点 ${site.pointCode} 同时段已被占用`);
      if (item.location === '洞内' && (index.caveCount.get(item.date) || 0) >= CAVE_QUOTA) {
        conflicts.push(`当日洞内设备配额 ${CAVE_QUOTA} 已用满`);
      }
    }

    if (conflicts.length) {
      item.draft = true;
      item.stage = '未开始';
      item.conflictReason = conflicts.join('；');
      if (site) item.basis = { ...basisFor(site), recalcCount: item.basis?.recalcCount || 0 };
      item.updatedAt = new Date().toISOString();
      item.history = item.history || [];
      item.history.unshift(stamp('冲突保留草稿', item.conflictReason));
      results.push({ item, ok: false, conflict: item.conflictReason });
      continue;
    }

    // 占用成功
    item.draft = false;
    item.stage = '未开始';
    item.conflictReason = '';
    item.basis = basisFor(site);
    item.updatedAt = new Date().toISOString();
    item.history = item.history || [];
    item.history.unshift(stamp('占用成功', `${item.date} ${item.slot} ${item.location}，${site.pointCode}`));
    index.surveyorMap.set(surveyorKey(item), item);
    if (item.equipmentId) index.equipmentMap.set(equipmentKey(item), item);
    index.siteMap.set(siteKey(item), item);
    if (item.location === '洞内') index.caveCount.set(item.date, (index.caveCount.get(item.date) || 0) + 1);
    results.push({ item, ok: true });
  }
  return results;
}

function batchStateFrom(surveys) {
  const occupied = surveys.filter((item) => !item.draft && item.stage === '未开始').length;
  const inProgress = surveys.filter((item) => item.stage === '进行中').length;
  const drafted = surveys.filter((item) => item.draft).length;
  const suspended = surveys.filter((item) => item.stage === '停测').length;
  const completed = surveys.filter((item) => item.stage === '已完成').length;
  let state = '已提交';
  if (drafted && occupied + inProgress + completed) state = '含草稿';
  else if (drafted) state = '待重试';
  else if (suspended && !occupied && !inProgress && !completed) state = '已停测';
  else if (completed && !drafted && !occupied && !inProgress) state = '已完成';
  return { state, occupied: occupied + inProgress, drafted, suspended };
}

function refreshBatch(db, batchNo) {
  const batch = db.batches.find((entry) => entry.batchNo === batchNo);
  if (!batch) return null;
  const members = db.surveys.filter((item) => item.batchNo === batchNo);
  const { state, occupied, drafted, suspended } = batchStateFrom(members);
  Object.assign(batch, { state, occupied, drafted, suspended, total: members.length, updatedAt: new Date().toISOString() });
  return batch;
}

// ---- 失效重算：CO2校准值或保护等级变更 ----
function recalcForSite(db, site, reasons) {
  const affected = { invalidated: 0, suspended: 0, resumed: 0 };
  const batchNos = new Set();

  for (const item of db.surveys || []) {
    if (item.siteId !== site.id) continue;

    if (item.stage === '已完成') {
      // 已完成：保留现场快照，基础参数仅作留痕，状态不失效
      item.basis = {
        ...basisFor(site),
        recalcCount: (item.basis?.recalcCount || 0) + 1,
        recalcAt: new Date().toISOString(),
        recalcReason: reasons.join('、'),
        snapshotKept: true
      };
      item.history = item.history || [];
      item.history.unshift(stamp('变更留痕', `${reasons.join('、')}；已完成记录保留现场快照`));
      item.updatedAt = new Date().toISOString();
      continue;
    }

    if (item.draft) {
      // 冲突草稿不占资源，只刷新重算依据，等用户按批次重试
      item.basis = { ...basisFor(site), recalcCount: (item.basis?.recalcCount || 0) + 1 };
      item.updatedAt = new Date().toISOString();
      continue;
    }

    // 尚未开始/进行中/停测的排期都要按新等级立即重算（已完成已在上面冻结分支处理）
    const wasSuspended = item.stage === '停测';
    if (!PLAN_STAGES.includes(item.stage) && !wasSuspended) continue;

    affected.invalidated += 1;
    item.basis = {
      ...basisFor(site),
      recalcCount: (item.basis?.recalcCount || 0) + 1,
      recalcAt: new Date().toISOString(),
      recalcReason: reasons.join('、')
    };
    item.history = item.history || [];
    item.history.unshift(stamp('失效重算', `${reasons.join('、')}，控制线上限 ${basisFor(site).co2ControlLine} ppm`));

    if (site.protectedStatus === '暂停开放') {
      item.stage = '停测';
      item.conflictReason = '';
      item.history.unshift(stamp('停测', `样点 ${site.pointCode} 暂停开放，立即释放占用`));
      affected.suspended += 1;
    }
    // 恢复开放的重新仲裁在循环后统一处理
    item.updatedAt = new Date().toISOString();
    batchNos.add(item.batchNo);
  }

  // 恢复开放：把原停测条目标记为待仲裁草稿，随后统一仲裁，冲突则退回草稿
  const resumedIds = [];
  if (site.protectedStatus !== '暂停开放') {
    for (const item of db.surveys || []) {
      if (item.siteId !== site.id || item.stage !== '停测') continue;
      item.draft = true;
      item.stage = '未开始';
      item.conflictReason = '样点恢复开放，等待重新占用';
      resumedIds.push(item.id);
      batchNos.add(item.batchNo);
    }
  }

  const resumedItems = resumedIds
    .map((id) => (db.surveys || []).find((item) => item.id === id))
    .filter(Boolean);
  if (resumedItems.length) {
    admitEntries(db, resumedItems);
    affected.resumed += resumedItems.length;
  }

  for (const batchNo of batchNos) {
    if (batchNo) refreshBatch(db, batchNo);
  }
  return affected;
}

// ---- 统一占用状态派生：样点、巡测、看板读同一份结果 ----
function buildOccupancy(db) {
  const index = buildAdmissionIndex(db);
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  const siteStatus = {};
  for (const site of db.sites || []) {
    if (site.protectedStatus === '暂停开放') {
      siteStatus[site.id] = { status: '停测', detail: '保护等级：暂停开放，所有未开始排期停测' };
      continue;
    }
    const drafts = (db.surveys || []).filter((item) => item.siteId === site.id && item.draft).length;
    const occupiedSlots = [];
    for (const item of db.surveys || []) {
      if (item.siteId !== site.id) continue;
      if (!item.draft && PLAN_STAGES.includes(item.stage)) {
        occupiedSlots.push(`${item.date} ${item.slot}（${item.surveyor}${item.stage === '进行中' ? '·进行中' : ''}）`);
      }
    }
    siteStatus[site.id] = {
      status: drafts ? '有草稿' : occupiedSlots.length ? '已占用' : '可排期',
      detail: occupiedSlots.length
        ? `占用时段：${occupiedSlots.slice(0, 3).join('，')}${drafts ? `；冲突草稿 ${drafts} 条` : ''}`
        : drafts ? `冲突草稿 ${drafts} 条，可按批次重试` : '当前无占用，可直接排期'
    };
  }

  const surveyStatus = {};
  for (const item of db.surveys || []) {
    if (item.stage === '已完成') {
      surveyStatus[item.id] = { status: '已完成', detail: '现场快照已冻结' };
    } else if (item.stage === '停测') {
      surveyStatus[item.id] = { status: '停测', detail: '样点暂停开放，占用已释放' };
    } else if (item.draft) {
      surveyStatus[item.id] = { status: '草稿', detail: item.conflictReason || '冲突保留草稿' };
    } else if (item.stage === '进行中') {
      surveyStatus[item.id] = { status: '进行中', detail: `${item.date} ${item.slot} ${item.location}` };
    } else {
      surveyStatus[item.id] = { status: '已提交', detail: `${item.date} ${item.slot} ${item.location}，已占用` };
    }
  }

  // 看板：按日期 → 时段 → 位置的格子
  const board = [];
  const days = new Set((db.surveys || []).map((item) => item.date).filter(Boolean));
  const dayList = [...days].sort();
  for (const date of dayList) {
    const dayItems = (db.surveys || []).filter((item) => item.date === date);
    const usedCave = index.caveCount.get(date) || 0;
    const slots = SLOTS.map((slot) => {
      const slotItems = dayItems.filter((item) => item.slot === slot);
      return {
        slot,
        items: slotItems.map((item) => ({
          id: item.id,
          surveyor: item.surveyor,
          siteId: item.siteId,
          site: siteLabel((db.sites || []).find((site) => site.id === item.siteId)),
          equipmentId: item.equipmentId,
          equipmentCode: (db.equipment || []).find((equip) => equip.id === item.equipmentId)?.code || '',
          location: item.location,
          stage: item.stage,
          draft: !!item.draft,
          status: surveyStatus[item.id]?.status,
          conflictReason: item.conflictReason || '',
          batchNo: item.batchNo
        }))
      };
    });
    board.push({
      date,
      caveUsed: usedCave,
      caveQuota: CAVE_QUOTA,
      caveFull: usedCave >= CAVE_QUOTA,
      drafts: dayItems.filter((item) => item.draft).length,
      suspended: dayItems.filter((item) => item.stage === '停测').length,
      slots
    });
  }

  const batches = (db.batches || []).map((batch) => ({ ...batch }));
  return {
    generatedAt: now.toISOString(),
    today,
    quota: { caveKitsPerDay: CAVE_QUOTA, slots: SLOTS, locations: LOCATIONS },
    todayCaveUsed: index.caveCount.get(today) || 0,
    draftCount: (db.surveys || []).filter((item) => item.draft).length,
    suspendedCount: (db.surveys || []).filter((item) => item.stage === '停测').length,
    siteStatus,
    surveyStatus,
    board,
    batches
  };
}

// ---- 只读接口 ----
app.get('/api/config', (req, res) => {
  res.json(config);
});

app.get('/api/db', async (req, res) => {
  const db = await readDb();
  db.occupancy = buildOccupancy(db);
  for (const key of Object.keys(db)) {
    if (Array.isArray(db[key])) db[key].sort(sortNewest);
  }
  res.json(db);
});

// ---- 通用写入（仍走写锁，避免与批次仲裁竞争） ----
app.post('/api/:collection', locked(async (req, res) => {
  try {
    const db = await readDb();
    const { collection } = req.params;
    if (collection === 'batches') return res.status(405).json({ error: '批次必须通过 /api/schedule/batches 提交' });
    if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
    const now = new Date().toISOString();
    const item = {
      id: `${collection}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
      ...req.body,
      createdAt: now,
      updatedAt: now,
      history: [stamp('创建', req.body.note || req.body.memo || '')]
    };
    // 直接登记的巡测视为现场已完成：立即冻结快照，不参与排期占用
    if (collection === 'surveys') {
      const site = (db.sites || []).find((entry) => entry.id === item.siteId);
      item.stage = '已完成';
      item.draft = false;
      item.conflictReason = '';
      item.basis = site ? basisFor(site) : item.basis;
      item.snapshot = site ? {
        siteCode: site.pointCode,
        protectedStatus: site.protectedStatus,
        baselineCo2: Number(site.baselineCo2) || 0,
        co2Calibration: Number(site.co2Calibration) || 0,
        co2ControlLine: basisFor(site).co2ControlLine,
        completedAt: now,
        note: '直接登记的现场记录，创建即冻结快照'
      } : item.snapshot;
      item.history.unshift(stamp('完成巡测', '直接登记，冻结现场快照'));
    }
    db[collection].push(item);
    await writeDb(db);
    res.status(201).json(item);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}));

app.patch('/api/:collection/:id', locked(async (req, res) => {
  try {
    const db = await readDb();
    const { collection, id } = req.params;
    if (collection === 'batches') return res.status(405).json({ error: '批次请用排期接口恢复' });
    if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
    const item = db[collection].find((entry) => entry.id === id);
    if (!item) return res.status(404).json({ error: 'not found' });

    const before = { protectedStatus: item.protectedStatus, co2Calibration: item.co2Calibration };
    const historyAction = req.body.historyAction;
    const patch = { ...req.body };
    delete patch.historyAction;
    Object.assign(item, patch, { updatedAt: new Date().toISOString() });
    item.history = item.history || [];
    if (historyAction || patch.note || patch.memo || patch.status) {
      item.history.unshift(stamp(historyAction || patch.status || '更新', patch.note || patch.memo || ''));
    }

    let recalc = null;
    if (collection === 'sites') {
      const reasons = [];
      if (patch.protectedStatus !== undefined && String(patch.protectedStatus) !== String(before.protectedStatus)) {
        reasons.push(`保护等级变更：${before.protectedStatus || '-'} → ${patch.protectedStatus}`);
      }
      if (patch.co2Calibration !== undefined && Number(patch.co2Calibration) !== Number(before.co2Calibration)) {
        reasons.push(`CO2校准值变更：${before.co2Calibration ?? 0} → ${patch.co2Calibration}`);
      }
      if (reasons.length) recalc = recalcForSite(db, item, reasons);
    }

    await writeDb(db);
    res.json(recalc ? { item, recalc } : item);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}));

app.delete('/api/:collection/:id', locked(async (req, res) => {
  try {
    const db = await readDb();
    const { collection, id } = req.params;
    if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
    const before = db[collection].length;
    const removed = db[collection].find((entry) => entry.id === id);
    db[collection] = db[collection].filter((entry) => entry.id !== id);
    if (db[collection].length === before) return res.status(404).json({ error: 'not found' });
    if (collection === 'surveys' && removed?.batchNo) refreshBatch(db, removed.batchNo);
    await writeDb(db);
    res.status(204).end();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}));

// ---- 排期批次：可恢复、幂等（batchNo 由客户端生成作为幂等键） ----
const ENTRY_FIELDS = ['siteId', 'surveyor', 'date', 'slot', 'location', 'equipmentId'];

function sanitizeEntry(body) {
  const entry = {};
  for (const field of ENTRY_FIELDS) entry[field] = body[field];
  return entry;
}

app.post('/api/schedule/batches', locked(async (req, res) => {
  let batchNo = String(req.body?.batchNo || '').trim();
  if (!batchNo) return res.status(400).json({ error: '缺少批次号 batchNo' });
  const note = String(req.body.note || '');
  let rawEntries = Array.isArray(req.body.entries) ? req.body.entries : [];

  try {
    const db = await readDb();
    let batch = db.batches.find((entry) => entry.batchNo === batchNo);
    const nowIso = new Date().toISOString();
    let created = false;
    let targetItems;

    if (!batch) {
      // 新批次：全部条目先落库为草稿，随后按到达顺序仲裁
      if (!rawEntries.length) return res.status(400).json({ error: '新批次至少包含一条排期' });
      batch = {
        id: `batch-${batchNo}`,
        batchNo,
        arrivalSeq: req.arrivalSeq,
        state: '待重试',
        total: rawEntries.length,
        occupied: 0,
        drafted: rawEntries.length,
        suspended: 0,
        note,
        createdAt: nowIso,
        updatedAt: nowIso
      };
      db.batches.push(batch);
      targetItems = rawEntries.map((raw, index) => ({
        id: `survey-${batchNo}-${index + 1}-${Math.random().toString(16).slice(2, 6)}`,
        ...sanitizeEntry(raw),
        batchNo,
        arrivalSeq: req.arrivalSeq,
        stage: '未开始',
        draft: true,
        conflictReason: '',
        temperature: null,
        humidity: null,
        co2: null,
        dripRate: null,
        disturbance: '',
        photoUrl: '',
        status: '正常',
        reviewNote: '',
        basis: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        history: [stamp('批次创建', `${batchNo} 第 ${index + 1} 条，到达序号 ${req.arrivalSeq}`)]
      }));
      db.surveys.push(...targetItems);
      created = true;
    } else {
      // 恢复/重试：支持只改待重试条目（带 id）或重提整批（不带 id）
      targetItems = db.surveys.filter((item) => item.batchNo === batchNo && item.draft);
      if (rawEntries.length) {
        rawEntries.forEach((raw, index) => {
          if (raw.id) {
            const target = targetItems.find((item) => item.id === raw.id);
            if (target) Object.assign(target, sanitizeEntry(raw));
          } else if (index < targetItems.length) {
            Object.assign(targetItems[index], sanitizeEntry(raw));
          }
        });
      }
      if (!targetItems.length) {
        return res.json({ created: false, batch: refreshBatch(db, batchNo), results: [], occupancy: buildOccupancy(db) });
      }
      batch.historyAction = stamp('批次重试', `按批次号恢复，待仲裁 ${targetItems.length} 条`);
    }

    const results = admitEntries(db, targetItems);
    const refreshed = refreshBatch(db, batchNo);
    if (batch.historyAction) {
      refreshed.history = refreshed.history || [];
      refreshed.history.unshift(batch.historyAction);
      delete batch.historyAction;
    }

    await writeDb(db);
    res.status(created ? 201 : 200).json({
      created,
      batchNo,
      arrivalSeq: batch.arrivalSeq,
      batch: refreshed,
      results: results.map((r) => ({
        id: r.item.id,
        ok: r.ok,
        suspended: !!r.suspended,
        draft: !!r.item.draft,
        stage: r.item.stage,
        conflictReason: r.item.conflictReason || '',
        conflict: r.conflict || ''
      })),
      occupancy: buildOccupancy(db)
    });
  } catch (error) {
    // 写入失败：客户端可用同一批次号原样重试，服务端不会产生重复批次
    res.status(500).json({ error: `批次写入失败：${error.message}`, batchNo, retryable: true });
  }
}));

// ---- 状态流转动作 ----
app.post('/api/action/:actionId/:id', locked(async (req, res) => {
  try {
    const db = await readDb();
    const action = config.actions.find((entry) => entry.id === req.params.actionId);
    if (!action) return res.status(404).json({ error: 'unknown action' });
    const item = db[action.collection]?.find((entry) => entry.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'not found' });
    const result = runAction(db, action, item);
    if (result.error) return res.status(409).json({ error: result.error });
    await writeDb(db);
    res.json(result.item);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}));

function runAction(db, action, item) {
  const related = action.relation ? findRelated(db, action.relation, item) : null;
  const context = { item, related };
  const beforeProtectedStatus = item.protectedStatus;
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

  if (action.freezeSnapshot && related) {
    const now = new Date().toISOString();
    item.snapshot = {
      siteCode: related.pointCode,
      protectedStatus: related.protectedStatus,
      baselineCo2: Number(related.baselineCo2) || 0,
      co2Calibration: Number(related.co2Calibration) || 0,
      co2ControlLine: basisFor(related).co2ControlLine,
      completedAt: now,
      note: '完成时冻结现场快照，后续校准值与保护等级变更不改写'
    };
    item.updatedAt = now;
    item.history = item.history || [];
    item.history.unshift(stamp('冻结快照', `控制线上限 ${item.snapshot.co2ControlLine} ppm`));
  }

  // 样点保护等级快捷动作（含“标记异常”联动重点保护）同样触发失效重算
  if (action.collection === 'sites' && beforeProtectedStatus !== item.protectedStatus) {
    runAction._recalc = recalcForSite(db, item, [`保护等级变更：${beforeProtectedStatus || '-'} → ${item.protectedStatus}`]);
  }
  return { item };
}

app.listen(PORT, () => {
  console.log(`${config.title} running at http://localhost:${PORT}`);
});
