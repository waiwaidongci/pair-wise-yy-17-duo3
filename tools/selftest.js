#!/usr/bin/env node
/**
 * 排期批次规则自检：node tools/selftest.js
 * 使用独立临时库（SCHEDULE_DB），不污染 data/db.json
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const TMP_DB = path.join(os.tmpdir(), `schedule-selftest-${Date.now()}.json`);
const PORT = 4391;
const BASE = `http://127.0.0.1:${PORT}`;

function seedDb() {
  const db = {
    sites: [
      { id: 's1', cave: '甲洞', zone: 'A区', pointCode: 'A-1', route: 'R1', sensitivity: '高', protectedStatus: '常规观察', baselineTemp: 16, baselineHumidity: 90, baselineCo2: 600, co2Calibration: 0, history: [] },
      { id: 's2', cave: '甲洞', zone: 'B区', pointCode: 'B-2', route: 'R2', sensitivity: '中', protectedStatus: '常规观察', baselineTemp: 16, baselineHumidity: 90, baselineCo2: 700, co2Calibration: 10, history: [] }
    ],
    equipment: [
      { id: 'e1', code: 'CQ-A', name: 'CO2仪1', scope: '洞内' },
      { id: 'e2', code: 'WQ-B', name: '温湿仪2', scope: '洞内' },
      { id: 'e3', code: 'DW-C', name: '洞外站', scope: '洞外' }
    ],
    surveys: [],
    batches: []
  };
  fs.writeFileSync(TMP_DB, JSON.stringify(db));
}

async function req(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(PORT), SCHEDULE_DB: TMP_DB },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('running at')) resolve(child);
    });
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    setTimeout(() => reject(new Error('server start timeout')), 5000);
  });
}

function entry(over = {}) {
  return { siteId: 's1', surveyor: '队员甲', date: '2026-11-01', slot: '上午', location: '洞内', equipmentId: 'e1', ...over };
}

(async () => {
  seedDb();
  const server = await startServer();
  try {
    // 1. 并发同号到达顺序：两人同时提交同一时段，先到占用，后到草稿
    const firstNo = 'T-CONC-1';
    const secondNo = 'T-CONC-2';
    const fired = await Promise.all([
      req('POST', '/api/schedule/batches', { batchNo: firstNo, entries: [entry()] }),
      // 用极小延迟制造“后到”；锁按进入 handler 的顺序排队
      sleep(15).then(() => req('POST', '/api/schedule/batches', { batchNo: secondNo, entries: [entry({ surveyor: '队员乙', equipmentId: 'e2' })] }))
    ]);
    assert.equal(fired[0].status, 201, '先到批次应创建成功');
    assert.equal(fired[0].json.batch.state, '已提交', '先到批次全部占用');
    assert.equal(fired[1].json.batch.state, '待重试', '后到批次保留草稿');
    assert.ok(fired[1].json.results[0].conflict.includes('样点 A-1 同时段'), `冲突原因应包含样点排重：${fired[1].json.results[0].conflict}`);
    assert.equal(fired[0].json.batch.arrivalSeq < fired[1].json.batch.arrivalSeq, true, '到达序号先到更小');
    console.log('✓ 并发先到先占：先到占用、后到草稿且给出冲突原因');

    // 2. 同队员同时段重复（设备不同、配额未满的下午）
    const dup = await req('POST', '/api/schedule/batches', {
      batchNo: 'T-DUP-1',
      entries: [entry({ date: '2026-11-02', slot: '下午' }), entry({ date: '2026-11-02', slot: '下午', siteId: 's2', equipmentId: 'e2', surveyor: '队员甲' })]
    });
    assert.equal(dup.json.results[0].draft, false);
    assert.equal(dup.json.results[1].draft, true);
    assert.ok(dup.json.results[1].conflict.includes('同队员队员甲'), '同队员同时段应冲突');
    console.log('✓ 同队员同时段排重');

    // 3. 同设备同时段排重（不同队员、洞外站不占洞内配额）
    const eq = await req('POST', '/api/schedule/batches', {
      batchNo: 'T-EQ-1',
      entries: [
        entry({ date: '2026-11-03', surveyor: '丙', equipmentId: 'e3', location: '洞外', siteId: 's2' }),
        entry({ date: '2026-11-03', surveyor: '丁', equipmentId: 'e3', location: '洞外', siteId: 's1' })
      ]
    });
    assert.equal(eq.json.results[0].draft, false);
    assert.equal(eq.json.results[1].draft, true);
    assert.ok(eq.json.results[1].conflict.includes('设备 DW-C 同时段'), '同设备同时段应冲突');
    console.log('✓ 同设备同时段排重（洞外不计入洞内配额）');

    // 4. 洞内每日两份设备配额
    const quota = await req('POST', '/api/schedule/batches', {
      batchNo: 'T-Q-1',
      entries: [
        entry({ date: '2026-11-04', surveyor: '甲', equipmentId: 'e1' }),
        entry({ date: '2026-11-04', surveyor: '乙', equipmentId: 'e2', siteId: 's2' }),
        entry({ date: '2026-11-04', surveyor: '丙', equipmentId: undefined, location: '洞内', siteId: 's2' })
      ]
    });
    assert.deepEqual(quota.json.results.map((r) => r.draft), [false, false, true]);
    assert.ok(quota.json.results[2].conflict.includes('洞内设备配额 2 已用满'));
    console.log('✓ 每天限带两份设备入洞');

    // 5. 幂等：同批次号重试不重复建单，且可改时段后恢复
    const retryAgain = await req('POST', '/api/schedule/batches', { batchNo: secondNo, entries: [] });
    assert.equal(retryAgain.status, 200, '同批次号重试应幂等返回');
    assert.equal(retryAgain.json.created, false);
    const dbAfterRetry = (await req('GET', '/api/db')).json;
    assert.equal(dbAfterRetry.batches.filter((b) => b.batchNo === secondNo).length, 1, '同号重试不产生重复批次');
    // 整批重提：把草稿改到无人的夜间
    const fixed2 = await req('POST', '/api/schedule/batches', {
      batchNo: secondNo,
      entries: [entry({ surveyor: '队员乙', equipmentId: 'e2', slot: '夜间' })]
    });
    assert.equal(fixed2.json.batch.state, '已提交', '改时段后重试应占用成功');
    assert.equal(fixed2.json.batch.drafted, 0);
    console.log('✓ 批次号幂等重试 + 草稿改时段恢复');

    // 6. 保护等级停测：未开始立即失效停测、释放配额；已完成保留快照
    const closeBatch = await req('POST', '/api/schedule/batches', {
      batchNo: 'T-CLOSE-1',
      entries: [entry({ date: '2026-11-05', surveyor: '甲', equipmentId: 'e1' })]
    });
    const planId = closeBatch.json.results[0].id;
    // 直接登记一条已完成现场记录
    const done = await req('POST', '/api/surveys', {
      siteId: 's1', surveyor: '老周', date: '2026-10-20', temperature: 15, humidity: 91, co2: 650,
      status: '正常', equipmentId: 'e1'
    });
    const doneId = done.json.id;
    assert.ok(done.json.snapshot, '直接登记应立即冻结快照');
    const snapshotBefore = JSON.stringify(done.json.snapshot);
    // 占用同日第二份设备，停测释放后应能新占
    const queued = await req('POST', '/api/schedule/batches', {
      batchNo: 'T-CLOSE-2',
      entries: [entry({ date: '2026-11-05', surveyor: '乙', equipmentId: 'e2', siteId: 's2' }), entry({ date: '2026-11-05', surveyor: '丙', equipmentId: 'e1' })]
    });
    assert.equal(queued.json.results[1].draft, true, '停测前第三份应排队为草稿');

    const patched = await req('PATCH', '/api/sites/s1', { protectedStatus: '暂停开放' });
    assert.ok(patched.json.recalc.invalidated >= 1, '未开始记录应失效重算');
    assert.equal(patched.json.recalc.suspended >= 1, true);
    const db1 = (await req('GET', '/api/db')).json;
    const planAfter = db1.surveys.find((s) => s.id === planId);
    assert.equal(planAfter.stage, '停测');
    assert.equal(planAfter.draft, false);
    const doneAfter = db1.surveys.find((s) => s.id === doneId);
    assert.equal(JSON.stringify(doneAfter.snapshot), snapshotBefore, '已完成记录快照不得被改写');
    assert.equal(doneAfter.stage, '已完成');
    assert.ok(doneAfter.history.some((h) => h.action === '变更留痕'), '已完成只留痕不失效');
    // 停测释放后，排队草稿重试应成功占用
    const recovered = await req('POST', '/api/schedule/batches', { batchNo: 'T-CLOSE-2', entries: [] });
    assert.equal(recovered.json.batch.drafted, 0, '停测释放配额后重试应全部占用');
    console.log('✓ 保护等级变更：未开始停测释放占用、已完成保留现场快照、释放后可恢复');

    // 7. CO2校准值变更：未开始失效重算（控制线更新），已完成快照不变
    const calBatch = await req('POST', '/api/schedule/batches', {
      batchNo: 'T-CAL-1',
      entries: [entry({ date: '2026-11-06', surveyor: '甲', equipmentId: 'e1' })]
    });
    const calId = calBatch.json.results[0].id;
    await req('PATCH', '/api/sites/s1', { protectedStatus: '常规观察' });
    const calPatch = await req('PATCH', '/api/sites/s1', { co2Calibration: 42 });
    assert.ok(calPatch.json.recalc.invalidated >= 1);
    const db2 = (await req('GET', '/api/db')).json;
    const calPlan = db2.surveys.find((s) => s.id === calId);
    assert.equal(calPlan.basis.co2ControlLine, 642, '控制线=基准600+校准42');
    assert.equal(calPlan.basis.recalcReason.includes('CO2校准值变更'), true);
    const doneAfter2 = db2.surveys.find((s) => s.id === doneId);
    assert.equal(JSON.stringify(doneAfter2.snapshot), snapshotBefore, '校准变更不改写已完成快照');
    console.log('✓ CO2校准值变更：未开始立即失效重算，已完成快照保留');

    // 8. 进行中 → 完成 冻结快照；之后校准再变快照不动
    await req('PATCH', '/api/sites/s1', { co2Calibration: 0 });
    const goBatch = await req('POST', '/api/schedule/batches', {
      batchNo: 'T-DONE-1',
      entries: [entry({ date: '2026-11-07', surveyor: '执行员', equipmentId: 'e1' })]
    });
    const goId = goBatch.json.results[0].id;
    const start = await req('POST', `/api/action/survey-start/${goId}`, {});
    assert.equal(start.json.stage, '进行中');
    const complete = await req('POST', `/api/action/survey-complete/${goId}`, {});
    assert.equal(complete.json.stage, '已完成');
    assert.equal(complete.json.snapshot.co2ControlLine, 600);
    await req('PATCH', '/api/sites/s1', { co2Calibration: 99 });
    const db3 = (await req('GET', '/api/db')).json;
    const goAfter = db3.surveys.find((s) => s.id === goId);
    assert.equal(goAfter.snapshot.co2ControlLine, 600, '完成后校准变化不得改写快照控制线');
    assert.equal(goAfter.basis.co2ControlLine, 699, '留痕依据仍更新');
    console.log('✓ 完成巡测冻结现场快照，后续校准变更只更新留痕依据');

    // 9. 草稿不能开始巡测（服务端 guard）
    const draftBatch = await req('POST', '/api/schedule/batches', {
      batchNo: 'T-GUARD-1',
      entries: [entry({ date: '2026-11-08', surveyor: '甲', equipmentId: 'e1' })]
    });
    // 人为制造草稿：同批次号第二次没法，直接再发一个冲突批次
    const draft2 = await req('POST', '/api/schedule/batches', {
      batchNo: 'T-GUARD-2',
      entries: [entry({ date: '2026-11-08', surveyor: '甲', equipmentId: 'e1' })]
    });
    const draftId = draft2.json.results[0].id;
    const guarded = await req('POST', `/api/action/survey-start/${draftId}`, {});
    assert.equal(guarded.status, 409);
    console.log('✓ 草稿未占用时段，服务端拒绝开始巡测');

    // 10. 看板/样点/巡测占用状态同源一致
    const db4 = (await req('GET', '/api/db')).json;
    const occ = db4.occupancy;
    assert.ok(occ.board.length, '看板应有日期格');
    const site1Status = occ.siteStatus.s1.status;
    assert.ok(['停测', '已占用', '有草稿', '可排期'].includes(site1Status));
    const boardSurveyIds = occ.board.flatMap((d) => d.slots.flatMap((s) => s.items.map((i) => i.id)));
    for (const s of db4.surveys) {
      assert.ok(occ.surveyStatus[s.id], `每条巡测都有派生状态：${s.id}`);
      if (boardSurveyIds.includes(s.id)) {
        const cell = occ.board.flatMap((d) => d.slots.flatMap((x) => x.items)).find((i) => i.id === s.id);
        assert.equal(cell.status, occ.surveyStatus[s.id].status, '看板格子状态与巡测派生状态一致');
      }
    }
    assert.equal(occ.quota.caveKitsPerDay, 2);
    console.log('✓ 样点、巡测、看板显示相同占用状态（统一派生）');

    console.log('\n全部自检通过 ✅');
  } finally {
    server.kill();
    try { fs.unlinkSync(TMP_DB); } catch {}
  }
})().catch((error) => {
  console.error('\n自检失败 ❌', error);
  process.exit(1);
});
