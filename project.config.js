module.exports = {
  port: 3912,
  title: '钟乳石洞穴微环境巡测',
  lede: '围绕洞穴、分区、样点和巡测路线记录微环境数据；洞内外排期按批次先到先占，设备配额、停测与失效重算统一由服务端裁决。',
  schedule: {
    slots: ['上午', '下午', '夜间'],
    locations: ['洞内', '洞外'],
    caveKitQuotaPerDay: 2
  },
  tones: {
    '常规观察': 'ok',
    '正常': 'ok',
    '已复查': 'ok',
    '已完成': 'ok',
    '已提交': 'ok',
    '可排期': 'ok',
    '重点保护': 'warn',
    '异常待复查': 'bad',
    '暂停开放': 'bad',
    '已占用': 'info',
    '进行中': 'warn',
    '草稿': 'warn',
    '含草稿': 'warn',
    '有草稿': 'warn',
    '待重试': 'bad',
    '停测': 'bad'
  },
  collections: {
    sites: { label: '样点档案' },
    surveys: { label: '巡测记录' },
    equipment: { label: '设备台账' },
    batches: { label: '排期批次' }
  },
  stats: [
    { label: '样点', collection: 'sites' },
    { label: '重点保护', collection: 'sites', filter: { field: 'protectedStatus', value: '重点保护' } },
    { label: '巡测记录', collection: 'surveys' },
    { label: '待复查', collection: 'surveys', filter: { field: 'status', value: '异常待复查' } },
    { label: '冲突草稿', collection: 'surveys', filter: { field: 'draft', value: true } },
    { label: '设备台账', collection: 'equipment' }
  ],
  views: [
    {
      id: 'dashboard',
      label: '趋势看板',
      type: 'dashboard',
      focusTitle: '异常与复查',
      focus: { collection: 'surveys', field: 'status', values: ['异常待复查'], limit: 8 }
    },
    {
      id: 'schedule',
      label: '洞内外排期',
      type: 'schedule'
    },
    {
      id: 'sites',
      label: '样点档案',
      collection: 'sites',
      formTitle: '新增样点',
      listTitle: '样点列表',
      submitLabel: '保存样点',
      searchPlaceholder: '搜索洞穴、分区、样点、路线',
      searchFields: ['cave', 'zone', 'pointCode', 'route'],
      statusField: 'protectedStatus',
      statusOptions: ['常规观察', '重点保护', '暂停开放'],
      titleFields: ['pointCode', 'zone'],
      summaryFields: ['note'],
      detailFields: [
        { label: '洞穴', name: 'cave' },
        { label: '巡测路线', name: 'route' },
        { label: '敏感等级', name: 'sensitivity' },
        { label: 'CO2校准值(ppm)', name: 'co2Calibration' }
      ],
      fields: [
        { label: '洞穴', name: 'cave', required: true },
        { label: '分区', name: 'zone', required: true },
        { label: '样点编号', name: 'pointCode', required: true },
        { label: '巡测路线', name: 'route', required: true },
        { label: '敏感等级', name: 'sensitivity', type: 'select', options: ['低', '中', '高'] },
        { label: '保护状态', name: 'protectedStatus', type: 'select', options: ['常规观察', '重点保护', '暂停开放'] },
        { label: '基准温度', name: 'baselineTemp', type: 'number', required: true },
        { label: '基准湿度', name: 'baselineHumidity', type: 'number', required: true },
        { label: '基准CO2', name: 'baselineCo2', type: 'number', required: true },
        { label: 'CO2校准值(ppm)', name: 'co2Calibration', type: 'number', default: 0, required: true },
        { label: '备注', name: 'note', type: 'textarea', wide: true }
      ]
    },
    {
      id: 'surveys',
      label: '巡测记录',
      collection: 'surveys',
      formTitle: '登记巡测（现场记录）',
      listTitle: '巡测历史',
      submitLabel: '保存巡测',
      searchPlaceholder: '搜索人员、干扰痕迹、批次',
      searchFields: ['surveyor', 'disturbance', 'photoUrl', 'batchNo'],
      statusField: 'status',
      statusOptions: ['正常', '异常待复查', '已复查'],
      titleFields: ['surveyor', 'date'],
      relation: { collection: 'sites', localKey: 'siteId', labelFields: ['cave', 'zone', 'pointCode'] },
      summaryFields: ['disturbance', 'reviewNote'],
      detailFields: [
        { label: '温度', name: 'temperature' },
        { label: '湿度', name: 'humidity' },
        { label: 'CO2', name: 'co2' },
        { label: '时段', name: 'slot' },
        { label: '位置', name: 'location' },
        { label: '设备', name: 'equipmentId', type: 'relation', collection: 'equipment', labelFields: ['code', 'name'] },
        { label: '批次号', name: 'batchNo' }
      ],
      defaults: { status: '正常', reviewNote: '' },
      fields: [
        { label: '样点', name: 'siteId', type: 'relation', collection: 'sites', labelFields: ['cave', 'zone', 'pointCode'], required: true, wide: true },
        { label: '巡测人员', name: 'surveyor', required: true },
        { label: '日期', name: 'date', type: 'date', required: true },
        { label: '时段', name: 'slot', type: 'select', options: ['上午', '下午', '夜间'], default: '上午' },
        { label: '位置', name: 'location', type: 'select', options: ['洞内', '洞外'], default: '洞内' },
        { label: '设备', name: 'equipmentId', type: 'relation', collection: 'equipment', labelFields: ['code', 'name'], wide: true },
        { label: '温度', name: 'temperature', type: 'number' },
        { label: '湿度', name: 'humidity', type: 'number' },
        { label: 'CO2', name: 'co2', type: 'number' },
        { label: '滴水频率', name: 'dripRate', type: 'number' },
        { label: '照片链接', name: 'photoUrl' },
        { label: '游客干扰痕迹', name: 'disturbance', type: 'textarea', wide: true }
      ]
    }
  ],
  actions: [
    { id: 'site-normal', label: '常规观察', collection: 'sites', patches: [{ field: 'protectedStatus', value: '常规观察' }] },
    { id: 'site-focus', label: '重点保护', collection: 'sites', patches: [{ field: 'protectedStatus', value: '重点保护' }] },
    { id: 'site-close', label: '暂停开放', collection: 'sites', danger: true, patches: [{ field: 'protectedStatus', value: '暂停开放' }] },
    {
      id: 'survey-alert',
      label: '标记异常',
      collection: 'surveys',
      relation: { collection: 'sites', localKey: 'siteId' },
      patches: [
        { field: 'status', value: '异常待复查' },
        { target: 'related', field: 'protectedStatus', value: '重点保护' }
      ]
    },
    { id: 'survey-review', label: '完成复查', collection: 'surveys', patches: [{ field: 'status', value: '已复查' }, { field: 'reviewNote', value: '异常已复核' }] },
    {
      id: 'survey-start',
      label: '开始巡测',
      collection: 'surveys',
      guards: [
        { op: 'eq', left: 'item.stage', right: '未开始', message: '只有未开始的排期可以开始' },
        { op: 'neq', left: 'item.draft', right: true, message: '草稿尚未占用时段，不能开始' }
      ],
      patches: [{ field: 'stage', value: '进行中' }]
    },
    {
      id: 'survey-complete',
      label: '完成巡测',
      collection: 'surveys',
      relation: { collection: 'sites', localKey: 'siteId' },
      guards: [
        { op: 'eq', left: 'item.stage', right: '进行中', message: '只有进行中的巡测可以完成' }
      ],
      freezeSnapshot: true,
      patches: [{ field: 'stage', value: '已完成' }]
    }
  ]
};
