/* =========================================================
   方格记账 v2 · 核心逻辑
   纯前端 · localStorage 持久化 · 面向「固定月薪」用户

   数据模型（fg_ledger_v2）
     init       是否已完成首次发薪状态设置
     mode       'grid'   未发工资·方格模式（工资→方格，月底结余并入储蓄）
                'wallet' 已发工资·钱包模式（无方格，消费直接从储蓄池扣）
     salary     方格模式的本月工资（钱包模式下保留作历史/预填）
     monthKey   当前账期 YYYY-MM
     entries    每笔记录 {id,cat,amount,note,ts,date,m}
                m:'grid'|'wallet' 记录所属模式
     saving     储蓄·总资产池（可被钱包消费实时扣减、被负结余补差）
     saveOps    直接储蓄流水 {id,amount,note,ts}
     goals      目标 [{id,name,target}]（串行达成：先满足金额小的）
     settleHist 每月自动结余 [{month,amount}]（近3月平均 → 预测）
     manualMonthly 手动月均可存（无历史结余时的预测兜底）
   ========================================================= */
'use strict';

/* ---------------- 分类定义 ---------------- */
const CATS = [
  { key: 'fixed',    label: '固定',   color: '#4A90E2', dark: '#2E69B6',
    chips: ['房租', '房贷', '话费', '保险'] },
  { key: 'must',     label: '必须',   color: '#F5A623', dark: '#C67A06',
    chips: ['吃饭', '通勤', '日用品', '水电燃气'] },
  { key: 'optional', label: '非必须', color: '#EF5350', dark: '#C62F2F',
    chips: ['奶茶', '咖啡', '外卖大餐', '网购'] },
  { key: 'member',   label: '会员',   color: '#4CAF50', dark: '#2E8A3D',
    chips: ['视频年费', 'App订阅', '购物会员'] },
];
const catOf = k => CATS.find(c => c.key === k);

/* ---------------- 存储 ---------------- */
const KEY = 'fg_ledger_v2';
const LEGACY_KEY = 'fg_ledger_v1';

const R2 = n => Math.round(n * 100) / 100;

function freshState() {
  return {
    ver: 2,
    init: false,
    mode: null,          // 'grid' | 'wallet' | null
    salary: null,        // 方格模式本月工资
    monthKey: null,      // 当前账期
    entries: [],         // 支出记录
    saving: 0,           // 储蓄·总资产池
    saveOps: [],         // 直接储蓄流水
    goals: [],           // 目标（串行）
    settleHist: [],      // 每月自动结余历史
    manualMonthly: null, // 手动月均可存（兜底）
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (d && typeof d === 'object') {
        return normalizeState(d);
      }
    }
  } catch (e) { /* 忽略损坏数据 */ }

  // 读不到 v2 → 尝试迁移 v1（旧数据不报错，转成方格模式）
  try {
    const old = localStorage.getItem(LEGACY_KEY);
    if (old) {
      const d = JSON.parse(old);
      if (d && typeof d === 'object' && Array.isArray(d.entries)) {
        const s = migrateFromV1(d);
        persistState(s);
        return s;
      }
    }
  } catch (e) { /* 忽略损坏的旧数据 */ }

  return freshState();
}

// 清洗 / 兜底：任何字段缺失都不报错
function normalizeState(d) {
  const s = freshState();
  s.init = d.init === true;
  s.mode = d.mode === 'wallet' ? 'wallet' : d.mode === 'grid' ? 'grid' : null;
  s.salary = isFinite(Number(d.salary)) ? R2(Number(d.salary)) : null;
  s.monthKey = typeof d.monthKey === 'string' ? d.monthKey : null;
  s.entries = Array.isArray(d.entries) ? d.entries.map(e => normalizeEntry(e)).filter(Boolean) : [];
  s.saving = isFinite(Number(d.saving)) ? R2(Number(d.saving)) : 0;
  s.saveOps = Array.isArray(d.saveOps) ? d.saveOps.filter(o => o && isFinite(o.amount)) : [];
  s.goals = Array.isArray(d.goals)
    ? d.goals.filter(g => g && g.name && isFinite(g.target)).map(g => ({
        id: String(g.id), name: String(g.name), target: Math.max(1, R2(g.target)),
      }))
    : [];
  s.settleHist = Array.isArray(d.settleHist)
    ? d.settleHist.filter(h => h && isFinite(h.amount)).map(h => ({ month: String(h.month), amount: R2(h.amount) }))
    : [];
  s.manualMonthly = isFinite(Number(d.manualMonthly)) ? Math.max(0, R2(Number(d.manualMonthly))) : null;
  return s;
}

function normalizeEntry(e) {
  if (!e || !isFinite(e.amount)) return null;
  if (!catOf(e.cat)) return null; // 只保留合法分类
  return {
    id: e.id ? String(e.id) : 'e' + Date.now() + Math.random().toString(36).slice(2, 7),
    cat: e.cat,
    amount: R2(Number(e.amount)),
    note: e.note ? String(e.note) : '',
    ts: isFinite(e.ts) ? Number(e.ts) : Date.now(),
    date: e.date ? String(e.date) : todayStr(),
    m: e.m === 'wallet' ? 'wallet' : 'grid',
    // sv：仅用于迁移 — 旧系统“手动储蓄”记录的当月标记，月结时并入总资产池
    sv: e.sv === true ? true : false,
    // dc：钱包模式入账时是否已实时扣减过储蓄池（删除时据此退回）
    dc: e.dc === true ? true : false,
  };
}

// v1 → v2：绝不报错。
//   · 旧“固定·储蓄 / 自动结算”内部流水 → 已结算月份的钱并入总资产池；
//   · 仍在“当月账期”内的手动储蓄 → 保留并打上 sv 标记，跟随当月方格一起月结
//     （净效果：该月总储蓄 = 工资 − 当月真实消费，和旧系统一致，不重复入池）；
//   · 真实消费原样保留，转为「未发工资 · 方格模式」。
function migrateFromV1(d) {
  const s = freshState();
  const salary = isFinite(Number(d.salary)) ? R2(Number(d.salary)) : null;
  s.salary = salary;

  // 账期
  let mk = null;
  if (typeof d.monthKey === 'string' && d.monthKey) mk = d.monthKey;
  const raw = Array.isArray(d.entries) ? d.entries : [];
  if (!mk) {
    const last = raw.reduce((mx, e) => Math.max(mx, Number(e.ts) || 0), 0);
    mk = last ? monthKeyOfTs(last) : curMonthKey();
  }
  s.monthKey = mk;

  let pool = 0;
  for (const e of raw) {
    const amt = isFinite(Number(e.amount)) ? Number(e.amount) : 0;
    if (amt <= 0) continue;
    const isSave = !!(e.save || e.auto);
    if (!isSave) {
      const n = normalizeEntry({ ...e, m: 'grid' });
      if (n) s.entries.push(n);
      continue;
    }
    // 旧储蓄/自动结算
    const em = e.ts ? monthKeyOfTs(Number(e.ts))
             : (typeof e.date === 'string' && e.date ? e.date.slice(0, 7) : null);
    if (em === mk && !e.auto) {
      // 还在当月账期内的“手动储蓄”→ 打 sv 标记留作月结
      const n = normalizeEntry({ ...e, m: 'grid', sv: true });
      if (n) s.entries.push(n);
    } else {
      pool += amt; // 已结算/历史：钱已经在储蓄池里
    }
  }
  s.saving = R2(pool);
  s.init = true;
  // 旧数据从没设过工资（没有方格预算）→ 按“钱包模式”看待，避免强制输入工资
  s.mode = salary != null ? 'grid' : 'wallet';
  return s;
}

function persistState(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch (e) { /* 存储满或不可用 */ }
}

/* ---------------- 计算规则 ---------------- */
const cellCost = 10;                                          // 10元 = 1 格
const cellOf = amt => Math.max(1, Math.ceil(amt / cellCost)); // 不足1格按1格
function cellsForSalary(sal) { return Math.max(0, Math.round(sal / cellCost)); }

const money = n => new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
                      .format(Math.round(n * 100) / 100);
const yuan = n => '¥' + money(n);

/* ---------------- 日期 / 月份工具 ---------------- */
const pad2 = n => String(n).padStart(2, '0');
const monthKeyOfTs = ts => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
};
const curMonthKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
};
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const labelMonth = key => {
  if (!key) return '';
  const [y, m] = key.split('-').map(Number);
  return `${y}年${m}月`;
};
function tsFromDate(dateStr) {
  const n = new Date();
  const d = new Date(dateStr + 'T00:00:00');
  d.setHours(n.getHours(), n.getMinutes(), n.getSeconds(), 0);
  return d.getTime();
}
function endOfMonthTs(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m, 0, 23, 59, 59, 999).getTime();
}
const fmtTime = ts => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

// 状态载入（必须在上面所有 const 日期工具初始化后再执行，否则迁移路径会抛 TDZ 错误）
let state = loadState();

/* ---------------- 月份视图数据 ---------------- */
// 当前账期内全部记录
function monthEntries() {
  if (!state.monthKey) return state.entries;
  return state.entries.filter(e => monthKeyOfTs(e.ts) === state.monthKey);
}
// 当前账期内、且属于当前模式的记录（方格模式只看 m=grid，钱包只看 m=wallet）
function viewEntries() {
  return monthEntries().filter(e => e.m === state.mode);
}
function sumAmt(list) { return list.reduce((s, e) => s + e.amount, 0); }
function sumCat(cat) { return sumAmt(viewEntries().filter(e => e.cat === cat)); }
function viewSpent() { return sumAmt(viewEntries()); }
// 方格模式的当月消费（结算用；钱包记录不算入方格预算）
function gridSpentOfMonth(mk) {
  return sumAmt(state.entries.filter(e => monthKeyOfTs(e.ts) === mk && e.m === 'grid'));
}
// 本月直接储蓄合计
function saveOpsOfMonth() {
  if (!state.monthKey) return state.saveOps;
  return state.saveOps.filter(o => monthKeyOfTs(o.ts) === state.monthKey);
}
function canRecord() {
  return state.init && (state.mode === 'wallet' || !!state.salary);
}

/* ---------------- DOM ---------------- */
const $ = id => document.getElementById(id);
const el = {
  // 工资卡三态
  salarySet: $('salarySet'), salaryView: $('salaryView'), walletView: $('walletView'),
  salaryForm: $('salaryForm'), salaryInput: $('salaryInput'),
  salarySetHint: $('salarySetHint'), btnCancelSalary: $('btnCancelSalary'),
  salaryNum: $('salaryNum'), salaryTotal: $('salaryTotal'), btnChangeSalary: $('btnChangeSalary'),
  btnSwitchToGrid: $('btnSwitchToGrid'),

  board: $('board'),
  statA: $('statA'), labA: $('labA'), statB: $('statB'), labB: $('labB'),
  statC: $('statC'), labC: $('labC'),

  legend: $('legend'),
  gridZone: $('gridZone'), grid: $('grid'), gridHint: $('gridHint'), emptyTip: $('emptyTip'),

  saveVal: $('saveVal'), saveSub: $('saveSub'), saveFoot: $('saveFoot'),
  btnDirectSave: $('btnDirectSave'), btnGoalMgr: $('btnGoalMgr'),
  goalSub: $('goalSub'), goalBody: $('goalBody'),

  entryForm: $('entryForm'), fabAdd: $('fabAdd'), btnFold: $('btnFold'),
  catSel: $('catSel'), amtInput: $('amtInput'),
  dateInput: $('dateInput'), noteInput: $('noteInput'), addBtn: $('addBtn'),

  payOverlay: $('payOverlay'), btnClosePay: $('btnClosePay'),
  payFormGrid: $('payFormGrid'), payGridSalary: $('payGridSalary'), payGridSave: $('payGridSave'),
  payFormWallet: $('payFormWallet'), payWalletSave: $('payWalletSave'),

  depOverlay: $('depOverlay'), depForm: $('depForm'),
  depAmount: $('depAmount'), depNote: $('depNote'), btnCloseDep: $('btnCloseDep'),

  goalOverlay: $('goalOverlay'), goalForm: $('goalForm'),
  goalName: $('goalName'), goalTarget: $('goalTarget'),
  goalList: $('goalList'), btnCloseGoal: $('btnCloseGoal'),

  sheetOverlay: $('sheetOverlay'), sheetDot: $('sheetDot'), sheetTitle: $('sheetTitle'),
  sheetCount: $('sheetCount'), sheetSum: $('sheetSum'),
  sheetList: $('sheetList'), sheetEmpty: $('sheetEmpty'), btnCloseSheet: $('btnCloseSheet'),

  menuOverlay: $('menuOverlay'), btnMenu: $('btnMenu'),
  miPay: $('miPay'), miDirectSave: $('miDirectSave'), miGoalMgr: $('miGoalMgr'),
  miSalary: $('miSalary'), miReset: $('miReset'), miResetAll: $('miResetAll'), miHow: $('miHow'),

  howOverlay: $('howOverlay'), btnCloseHow: $('btnCloseHow'),
  noticeOverlay: $('noticeOverlay'), noticeTitle: $('noticeTitle'),
  noticeBody: $('noticeBody'), btnCloseNotice: $('btnCloseNotice'),
  toast: $('toast'),
};

/* ---------------- 基础状态 ---------------- */
let totalCells = cellsForSalary(state.salary || 0);
let cellNodes = [];
let cols = 24;
let openCat = null;   // 当前打开的分类明细
let undoItem = null;  // 单步撤销
let payReopen = false;

/* ================= 方格渲染 ================= */
function layout() {
  if (!el.board.hidden && !el.gridZone.hidden) {
    const w = el.grid.clientWidth;
    if (!w) return;
    const divisor = Math.min(18, Math.max(12, Math.floor(w / 28)));
    cols = Math.max(8, Math.floor(w / divisor));
    el.grid.style.setProperty('--cols', cols);
  }
}
function buildCells() {
  el.grid.innerHTML = '';
  cellNodes = [];
  const frag = document.createDocumentFragment();
  for (let i = 0; i < totalCells; i++) {
    const c = document.createElement('div');
    c.className = 'cell';
    c._cat = null;
    frag.appendChild(c);
    cellNodes.push(c);
  }
  el.grid.appendChild(frag);
}

// 某分类本月需占用的格数（按笔数各自向上取整后相加）
function wantCells(cat) {
  return sumAmt(viewEntries().filter(e => e.cat === cat).map(e => ({ amount: cellOf(e.amount) })));
}

function paintGrid() {
  if (state.mode !== 'grid' || !state.salary) return;
  const budget = cellsForSalary(state.salary);
  const wants = CATS.map(c => ({ key: c.key, want: wantCells(c.key) }));
  const totalWants = wants.reduce((s, w) => s + w.want, 0);
  const over = Math.max(0, totalWants - budget);
  const total = budget + over;

  if (total !== totalCells || cellNodes.length !== total) {
    totalCells = total;
    buildCells();
  }
  const n = totalCells;
  const noLine = 'none';
  const line = 'inset 0 0 0 1px rgba(0,0,0,0.03)';

  // 先清为白格
  for (let i = 0; i < n; i++) {
    const node = cellNodes[i];
    node._cat = '';
    node.style.background = 'rgb(255, 255, 255)';
    node.style.boxShadow = line;
    node.classList.remove('over');
    delete node.dataset.cat;
  }

  // 按固定顺序（固定→必须→非必须→会员）连续上色，同类自动合并成大方块
  let ptr = 0;
  for (const c of CATS) {
    const w = wants.find(x => x.key === c.key).want;
    for (let i = ptr; i < Math.min(ptr + w, n); i++) {
      const node = cellNodes[i];
      node._cat = c.key;
      node.style.background = c.color;
      node.style.boxShadow = noLine;
      node.dataset.cat = c.key;
    }
    ptr += w;
  }

  // 超支部分（超过工资总格数）涂成深红“负数状态”
  if (over > 0) {
    for (let i = budget; i < Math.min(budget + over, n); i++) {
      const node = cellNodes[i];
      node.style.background = '';   // 清掉分类底色，让 CSS 深红斜纹生效
      node.style.boxShadow = 'none';
      node.classList.add('over');
      node._cat = 'over';
      delete node.dataset.cat;
    }
  }
}

function paintHint() {
  if (state.mode !== 'grid' || !state.salary) return;
  const budget = cellsForSalary(state.salary);
  const spent = viewSpent();
  const remain = R2(state.salary - spent);
  let t =
    `本月 ${labelMonth(state.monthKey)} · 每格 ${cellCost} 元 · 共 ${budget} 格 · ` +
    `同类自动连成大方块（固定→必须→非必须→会员）`;
  if (remain < 0) {
    t += ` · 已超支 <b>${yuan(-remain)}</b>：超出的部分显示为深红格，月底会自动从储蓄池补差`;
  } else {
    t += ` · 剩余白格 <b>${yuan(remain)}</b>，月底自动并入储蓄池`;
  }
  el.gridHint.innerHTML = t;
}

el.grid.addEventListener('click', e => {
  const cell = e.target.closest('.cell');
  if (!cell) return;
  if (cell.classList.contains('over')) {
    const remain = R2((state.salary || 0) - viewSpent());
    toast(`🔴 超支 ${yuan(-remain)}：钱不够花了。红格会在月底自动从储蓄池补差。`);
    return;
  }
  const cat = cell.dataset.cat;
  if (cat) { openSheet(cat); return; }
  const remain = R2((state.salary || 0) - viewSpent());
  toast(remain > 0 ? `白色格 = 本月剩余可用 ${yuan(remain)}` : '本月工资格已全部用完');
});

/* ================= 分类图例 ================= */
function renderLegend() {
  el.legend.innerHTML = '';
  for (const c of CATS) {
    const amt = sumCat(c.key);
    const b = document.createElement('button');
    b.className = 'legend-chip';
    b.type = 'button';
    const i = document.createElement('i');
    i.style.background = c.color;
    const s = document.createElement('span');
    s.textContent = c.label;
    const sm = document.createElement('small');
    sm.textContent = amt > 0 ? yuan(amt) : '0';
    b.append(i, s, sm);
    b.addEventListener('click', () => openSheet(c.key));
    el.legend.appendChild(b);
  }
}

/* ================= 分类明细浮层 ================= */
function openSheet(catKey) {
  const c = catOf(catKey);
  openCat = catKey;
  el.sheetDot.style.background = c.color;
  el.sheetTitle.textContent = `${c.label} · 本月明细`;
  renderSheet();
  show(el.sheetOverlay);
}
function renderSheet() {
  if (!openCat) return;
  const list = viewEntries()
    .filter(e => e.cat === openCat)
    .sort((a, b) => b.ts - a.ts);
  el.sheetCount.textContent = `${list.length} 笔`;
  el.sheetSum.textContent = yuan(sumAmt(list));
  el.sheetSum.style.color = catOf(openCat).color;

  el.sheetList.innerHTML = '';
  el.sheetEmpty.hidden = list.length !== 0;
  const mk = state.monthKey ? labelMonth(state.monthKey) : '本月';
  el.sheetEmpty.textContent = `${mk}${state.mode === 'wallet' ? '（钱包模式）' : ''}该分类还没有记录`;

  for (const e of list) {
    const li = document.createElement('li');
    li.className = 'sheet-item';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const nt = document.createElement('div');
    nt.className = 'nt';
    nt.textContent = e.note || '(未填写备注)';
    if (e.m === 'wallet') {
      const tag = document.createElement('span');
      tag.className = 'tag-save';
      tag.style.cssText = 'color:#B4660A;background:rgba(245,166,35,.16)';
      tag.textContent = '钱包直扣';
      nt.appendChild(tag);
    }
    const tm = document.createElement('div');
    tm.className = 'tm';
    tm.textContent = fmtTime(e.ts);
    meta.append(nt, tm);

    const amt = document.createElement('span');
    amt.className = 'amt';
    amt.textContent = yuan(e.amount);
    amt.style.color = catOf(e.cat).dark;

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del-btn';
    del.textContent = '✕';
    del.title = '删除';
    del.addEventListener('click', () => onDeleteTap(del, e.id));

    li.append(meta, amt, del);
    el.sheetList.appendChild(li);
  }
}

/* 删除：第一次点击确认，再点一次删除 */
function onDeleteTap(btn, id) {
  if (!btn.dataset.arm) {
    btn.dataset.arm = '1';
    btn.classList.add('arm');
    btn.textContent = '确认删除？';
    clearTimeout(btn._t);
    btn._t = setTimeout(() => {
      delete btn.dataset.arm;
      btn.classList.remove('arm');
      btn.textContent = '✕';
    }, 2600);
    return;
  }
  deleteItem(id);
}
function deleteItem(id) {
  const i = state.entries.findIndex(e => e.id === id);
  if (i < 0) return;
  const it = state.entries[i];
  state.entries.splice(i, 1);
  // 钱包模式下这笔曾实时扣减储蓄池 → 删除时退回
  if (it.dc) state.saving = R2(state.saving + it.amount);
  undoItem = it;
  save();
  refreshBoard();
  toast('已删除', { undo: true });
}
function undoDelete() {
  if (!undoItem) return;
  if (undoItem.dc) state.saving = R2(state.saving - undoItem.amount);
  state.entries.push(undoItem);
  undoItem = null;
  save();
  refreshBoard();
  toast('已恢复该笔记录');
}

/* ================= 储蓄卡 ================= */
function renderSaving() {
  el.saveVal.textContent = yuan(state.saving);
  el.saveVal.classList.toggle('neg', state.saving < 0);

  if (state.mode === 'wallet') {
    el.saveFoot.innerHTML =
      state.saving < 0
        ? '储蓄池已透支 ⚠️ —— 钱包模式下每笔消费都在实时扣减，请尽快「＋直接储蓄」补上。'
        : '钱包模式下每笔消费实时从池里扣；工资/奖金到手后记得「＋直接储蓄」入账。';
  } else if (state.mode === 'grid') {
    const avg = avgMonthlySurplus();
    if (avg !== null && avg > 0) {
      const h = state.settleHist.slice(-3).map(x => x.amount);
      el.saveFoot.innerHTML =
        `近 3 个月每月自动结余：<b>${h.map(a => yuan(a)).join(' / ')}</b> · 平均每月可存 <b>${yuan(avg)}</b>`;
    } else {
      el.saveFoot.innerHTML =
        '本月方格结余会在月底自动并入本池；花超则自动从本池补差。也可用「＋直接储蓄」提前入账。';
    }
  }
}

/* ================= 里程碑 · 目标池（串行） ================= */
const sortedGoals = () => [...state.goals].sort((a, b) => a.target - b.target);
// 近3月平均每月可存（来自历史自动结算）；无数据/<=0 返回 null
function avgMonthlySurplus() {
  const h = state.settleHist.slice(-3);
  if (!h.length) return null;
  const avg = sumAmt(h) / h.length;
  return avg > 0 ? avg : null;
}

function monthsTo(target) {
  if (state.saving >= target) return 0;
  const avg = avgMonthlySurplus();
  const basis = avg !== null ? avg : (isFinite(Number(state.manualMonthly)) && state.manualMonthly > 0 ? state.manualMonthly : null);
  if (!basis) return null;
  const need = R2(target - state.saving);
  return Math.ceil(need / basis);
}
function humanizeMonths(m) {
  if (m === null) return null;
  if (m <= 0) return '即将达成';
  if (m < 24) return `约 ${m} 个月后达成`;
  const y = Math.floor(m / 12), mo = m % 12;
  return mo ? `约 ${y} 年 ${mo} 个月后达成` : `约 ${y} 年后达成`;
}
function predSourceLine() {
  const avg = avgMonthlySurplus();
  if (avg !== null) return `按近 3 个月平均每月可存 ${yuan(avg)} 估算`;
  if (isFinite(Number(state.manualMonthly)) && state.manualMonthly > 0)
    return `按手动填写的每月可存 ${yuan(state.manualMonthly)} 估算`;
  return null;
}

function renderGoals() {
  const list = sortedGoals();
  el.goalBody.innerHTML = '';

  if (!list.length) {
    const empty = document.createElement('p');
    empty.className = 'goal-body-empty';
    empty.textContent = '还没有目标。储蓄池会串行推进目标：先存满第一个，再自动轮到下一个。';
    el.goalBody.appendChild(empty);
    const row = document.createElement('div');
    row.className = 'goal-tpls2';
    const tpls = [['🏠 买房', 500000], ['🚗 买车', 120000], ['🧯 应急金', 60000]];
    for (const [label, target] of tpls) {
      const b = document.createElement('button');
      b.type = 'button';
      const s = document.createElement('small');
      s.textContent = yuan(target);
      b.append(label, s);
      b.addEventListener('click', () => addGoalByTpl(label.replace(/^\S*\s/, ''), target));
      row.appendChild(b);
    }
    el.goalBody.appendChild(row);
    return;
  }

  // 已达成（目标金额 ≤ 当前储蓄）与当前推进的目标
  const achieved = list.filter(g => state.saving >= g.target);
  const current = list.find(g => state.saving < g.target) || null;

  if (achieved.length) {
    const box = document.createElement('div');
    box.className = 'goal-achv';
    for (const g of achieved) {
      const chip = document.createElement('span');
      chip.className = 'ach-chip';
      chip.textContent = `${g.name} ${yuan(g.target)} ✓`;
      box.appendChild(chip);
    }
    el.goalBody.appendChild(box);
  }

  if (current) {
    const pct = Math.min(100, Math.max(0, (state.saving / current.target) * 100));
    const need = R2(current.target - state.saving);

    const card = document.createElement('div');
    card.className = 'current-goal';

    const top = document.createElement('div');
    top.className = 'cg-top';
    const ic = document.createElement('span');
    ic.className = 'cg-ic';
    ic.textContent = '🎯';
    const nm = document.createElement('span');
    nm.className = 'cg-name';
    nm.textContent = current.name;
    const sub = document.createElement('span');
    sub.className = 'cg-sub';
    sub.textContent = `${yuan(state.saving)} / ${yuan(current.target)}`;
    top.append(ic, nm, sub);
    card.appendChild(top);

    const track = document.createElement('div');
    track.className = 'track cg-track';
    const fill = document.createElement('div');
    fill.className = 'track-fill' + (pct >= 100 ? ' done' : pct >= 80 ? ' s3' : pct >= 45 ? ' s2' : ' s1');
    fill.style.width = Math.max(pct, pct > 0 ? 1.2 : 0) + '%';
    track.appendChild(fill);
    card.appendChild(track);

    const pred = document.createElement('div');
    pred.className = 'cg-pred';
    const src = predSourceLine();
    if (state.saving >= current.target) {
      pred.innerHTML = `🎉 已达成，即将自动推进到下一个目标`;
    } else if (src) {
      const m = monthsTo(current.target);
      pred.innerHTML = `还差 <b>${yuan(need)}</b> · ${src} → <b>${humanizeMonths(m)}</b>`;
    } else {
      // 无任何结余依据 → 手动填写每月可存
      pred.innerHTML = `还差 <b>${yuan(need)}</b> · 还没有每月结余数据：`;
      const row = document.createElement('div');
      row.className = 'manual-row';
      const lab = document.createElement('span');
      lab.textContent = '我每月大约能存';
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.inputMode = 'decimal';
      inp.min = '0';
      inp.placeholder = '2000';
      inp.value = isFinite(Number(state.manualMonthly)) && state.manualMonthly > 0 ? state.manualMonthly : '';
      const unit = document.createElement('span');
      unit.textContent = '元';
      inp.addEventListener('change', () => {
        const v = parseFloat(inp.value);
        if (isFinite(v) && v > 0) {
          state.manualMonthly = R2(v);
          save();
          refreshBoard();
          toast(`已记录：每月可存 ${yuan(v)}，用来估算目标进度`);
        }
      });
      row.append(lab, inp, unit);
      pred.appendChild(row);
      card.appendChild(pred);
      el.goalBody.appendChild(card);

      if (list.length > 1) {
        const hint = document.createElement('p');
        hint.className = 'goal-next-hint';
        hint.textContent = '达成后自动推进到下一个目标（按金额从小到大）。';
        el.goalBody.appendChild(hint);
      }
      return;
    }
    card.appendChild(pred);
    el.goalBody.appendChild(card);

    if (list.length > 1) {
      const hint = document.createElement('p');
      hint.className = 'goal-next-hint';
      hint.textContent = '达成后自动推进到下一个目标（按金额从小到大）。';
      el.goalBody.appendChild(hint);
    }
  } else {
    // 所有目标都已达成
    const p = document.createElement('p');
    p.className = 'cg-pred';
    p.innerHTML = '🎉 当前所有目标都已达成！可点「管理目标」或「＋」新增下一个目标。';
    el.goalBody.appendChild(p);
  }
}

function addGoalByTpl(name, target) {
  if (state.goals.some(g => g.name === name)) { toast(`「${name}」目标已存在`); return; }
  state.goals.push({ id: 'g' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), name, target: R2(target) });
  save();
  refreshBoard();
  toast(`已添加目标「${name}」${yuan(target)}`);
}

/* ================= 目标管理浮层 ================= */
function renderGoalList() {
  el.goalList.innerHTML = '';
  const list = sortedGoals();
  for (const g of list) {
    const li = document.createElement('li');
    li.className = 'goal-row';
    const info = document.createElement('div');
    info.className = 'g-info';
    const nm = document.createElement('div');
    nm.className = 'g-name';
    nm.textContent = g.name;
    const mt = document.createElement('div');
    mt.className = 'g-meta';
    const reached = state.saving >= g.target;
    mt.textContent = `目标 ${yuan(g.target)}` + (reached ? ' · 已达成' : ` · 已存 ${yuan(Math.min(state.saving, g.target))}`);
    info.append(nm, mt);
    li.appendChild(info);
    if (reached) {
      const done = document.createElement('span');
      done.className = 'g-done';
      done.textContent = '✓';
      li.appendChild(done);
    }
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del-goal';
    del.textContent = '✕';
    del.title = '删除该目标';
    del.addEventListener('click', () => {
      if (!confirm(`删除目标「${g.name}」？不影响已存入储蓄池的钱。`)) return;
      state.goals = state.goals.filter(x => x.id !== g.id);
      save();
      renderGoalList();
      refreshBoard();
      toast('已删除目标');
    });
    li.appendChild(del);
    el.goalList.appendChild(li);
  }
}

/* ================= 顶部统计 ================= */
function refreshStats() {
  const mode = state.mode;
  if (mode === 'wallet') {
    const spent = viewSpent();
    const dep = sumAmt(saveOpsOfMonth());
    const net = R2(dep - spent);
    el.labA.textContent = '储蓄总池';
    el.labB.textContent = '本月支出';
    el.labC.textContent = '本月结余';
    el.statA.textContent = yuan(state.saving);
    el.statB.textContent = yuan(spent);
    el.statC.textContent = net < 0 ? '-' + yuan(-net) : yuan(net);
    toggleOflow(el.statC.closest('.stat'), net < 0);
    toggleOflow(el.statA.closest('.stat'), state.saving < 0);
    return;
  }
  const salary = state.salary || 0;
  const spent = viewSpent();
  const remain = R2(salary - spent);
  el.labA.textContent = '月薪';
  el.labB.textContent = '已支出';
  el.labC.textContent = '剩余';
  el.statA.textContent = yuan(salary);
  el.statB.textContent = yuan(spent);
  el.statC.textContent = remain < 0 ? '-' + yuan(-remain) : yuan(remain);
  toggleOflow(el.statA.closest('.stat'), false);
  toggleOflow(el.statB.closest('.stat'), false);
  toggleOflow(el.statC.closest('.stat'), remain < 0);
}
function toggleOflow(node, on) { if (node) node.classList.toggle('oflow', on); }

/* ================= 主刷新 ================= */
function refreshBoard() {
  if (state.mode === 'grid') {
    paintGrid();
    paintHint();
  }
  renderSaving();
  renderGoals();
  refreshStats();
  renderLegend();

  if (state.mode === 'grid' && state.salary) {
    el.salaryNum.textContent = money(state.salary);
    el.salaryTotal.textContent = `${cellsForSalary(state.salary)} 格`;
  }

  if (openCat) renderSheet();

  el.emptyTip.hidden = viewEntries().length !== 0;
}

/* ================= 视图切换 ================= */
function applyBoardViews() {
  const g = state.mode === 'grid';
  hide(el.salarySet); hide(el.salaryView); hide(el.walletView);
  hide(el.btnCancelSalary);

  document.body.classList.toggle('boot-pending', !state.init);

  if (!state.init) {
    hide(el.board); hide(el.fabAdd);
    hide(el.entryForm);
    el.entryForm.classList.remove('open');
    document.body.classList.remove('has-panel', 'panel-open');
    return;
  }

  // 工资卡三态
  if (g) {
    if (state.salary) {
      show(el.salaryView);
      const sal = state.salary;
      el.salaryNum.textContent = money(sal);
      el.salaryTotal.textContent = `${cellsForSalary(sal)} 格`;
    } else {
      show(el.salarySet);
      el.salarySetHint.textContent = salaryHintText();
    }
  } else {
    show(el.walletView);
  }

  // 主内容
  const can = canRecord();
  el.board.hidden = !can;
  el.gridZone.hidden = !(g && state.salary);
  if (can) {
    refreshBoard();
    // 收好录入抽屉，只留悬浮「＋ 记一笔」
    closePanel(false);
    layout();
  } else {
    hide(el.fabAdd);
    hide(el.entryForm);
    el.entryForm.classList.remove('open');
    document.body.classList.remove('panel-open');
  }
}
function salaryHintText() {
  const pre = isFinite(Number(state.salary)) && state.salary > 0 ? state.salary : null;
  return pre
    ? `每格 = 10 元 → ${money(pre)} 元会生成 ${cellsForSalary(pre)} 个白色小方格。上月工资 ${yuan(pre)} 可直接沿用。`
    : `每格 = 10 元 → 8000 元会生成 800 个白色小方格。下月起可一键沿用上月工资。`;
}

/* ---- 发薪状态浮层 ---- */
function openPayOverlay(fromMenu) {
  closePanel(true);
  if (fromMenu) {
    if (state.init && monthEntries().length) {
      const ok = confirm(
        `本月已有 ${monthEntries().length} 笔记录。\n\n切换发薪状态会影响之后的结算/扣款方式（跨月自动结算按原模式处理）。\n仍要修改吗？`
      );
      if (!ok) return;
    }
    payReopen = true;
    show(el.btnClosePay);
  } else {
    payReopen = false;
    hide(el.btnClosePay);
  }
  // 预填
  const preSal = state.salary || (isFinite(Number(state.salary)) ? state.salary : null);
  el.payGridSalary.value = state.mode === 'grid' && state.salary ? state.salary : (preSal || '');
  el.payGridSave.value = '';
  el.payWalletSave.value = '';
  document.body.classList.add('boot-pending'); // 首次时盖住工资卡
  show(el.payOverlay);
}
function closePayOverlay() {
  hide(el.payOverlay);
  payReopen = false;
  if (!state.init) return;
  document.body.classList.remove('boot-pending');
  applyBoardViews();
}
el.btnClosePay.addEventListener('click', () => { if (payReopen) closePayOverlay(); });
el.btnSwitchToGrid.addEventListener('click', () => openPayOverlay(true));
// 点击遮罩：重新打开时可关闭
el.payOverlay.addEventListener('click', e => {
  if (payReopen && e.target === el.payOverlay) closePayOverlay();
});

el.payFormGrid.addEventListener('submit', e => {
  e.preventDefault();
  const sal = parseFloat(el.payGridSalary.value);
  const exSave = parseFloat(el.payGridSave.value || '0') || 0;
  if (!isFinite(sal) || sal <= 0) { toast('请输入正确的本月工资'); return; }
  if (sal > 200000) { toast('请输入 ≤ 200,000 的工资'); return; }
  if (!isFinite(exSave) || exSave < 0) { toast('已有储蓄金额不正确'); return; }

  const firstInit = !state.init;
  const salR = R2(sal);

  // 重复打开且没改任何东西 → 直接关闭
  if (state.init && state.mode === 'grid' && state.salary === salR && exSave <= 0) {
    closePayOverlay();
    toast('未做更改');
    return;
  }

  if (firstInit) state.saving = R2(exSave);       // 首次：录入已有储蓄
  else if (exSave > 0) state.saving = R2(state.saving + exSave); // 补录/转入

  state.init = true;
  state.mode = 'grid';
  state.salary = salR;
  if (!state.monthKey) state.monthKey = curMonthKey();
  save();
  closePayOverlay();
  toast(`已设为方格模式，生成 ${cellsForSalary(salR)} 个方格`);
});

el.payFormWallet.addEventListener('submit', e => {
  e.preventDefault();
  const amt = parseFloat(el.payWalletSave.value);
  if (!isFinite(amt) || amt < 0) { toast('请输入正确的现有储蓄金额'); return; }
  const firstInit = !state.init;
  const r = R2(amt);
  if (firstInit) state.saving = r;
  else state.saving = R2(state.saving + r); // 已是钱包/方格：将工资转入池中

  state.init = true;
  state.mode = 'wallet';
  if (!state.monthKey) state.monthKey = curMonthKey();
  save();
  closePayOverlay();
  toast(firstInit ? '已设为钱包模式：之后每笔消费从储蓄池直接扣除' : `已转入储蓄池 ${yuan(r)}，切换为钱包模式`);
});

/* ================= 方格工资 设置 / 修改 ================= */
function startSalaryEdit() {
  closePanel(true);
  hide(el.fabAdd);
  hide(el.salaryView);
  show(el.salarySet);
  show(el.btnCancelSalary);
  el.salarySetHint.textContent = salaryHintText();
  el.salaryInput.value = state.salary || '';
  setTimeout(() => { el.salaryInput.focus(); el.salaryInput.select(); }, 60);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
el.btnChangeSalary.addEventListener('click', startSalaryEdit);
el.btnCancelSalary.addEventListener('click', applyBoardViews);
el.salaryForm.addEventListener('submit', e => {
  e.preventDefault();
  const v = parseFloat(el.salaryInput.value);
  if (!isFinite(v) || v <= 0) { toast('请输入正确的月薪金额'); return; }
  if (v > 200000) { toast('请输入 ≤ 200,000 的月薪'); return; }
  state.salary = R2(v);
  if (!state.monthKey) state.monthKey = curMonthKey();
  if (state.mode !== 'grid') state.mode = 'grid'; // 从无工资态补设
  state.init = true;
  save();
  applyBoardViews();
  toast(`已生成 ${cellsForSalary(state.salary)} 个方格`);
});

/* ================= 底部录入面板（抽屉） ================= */
function openPanel() {
  if (!canRecord()) { toast('请先完成发薪状态设置'); return; }
  el.entryForm.hidden = false;
  document.body.classList.add('has-panel', 'panel-open');
  el.entryForm.classList.add('open');
  hide(el.fabAdd);
  el.entryForm.scrollTop = 0;
  setTimeout(() => { try { el.amtInput.focus(); } catch (e) {} }, 360);
}
function closePanel(blurInput) {
  el.entryForm.classList.remove('open');
  document.body.classList.remove('panel-open');
  if (canRecord()) show(el.fabAdd);
  else { hide(el.entryForm); hide(el.fabAdd); }
  if (blurInput) { try { el.amtInput.blur(); } catch (e) {} }
}
el.fabAdd.addEventListener('click', () => openPanel());
el.btnFold.addEventListener('click', () => closePanel(true));

function buildCatOptions() {
  el.catSel.innerHTML = '';
  for (const c of CATS) {
    const o = document.createElement('option');
    o.value = c.key;
    o.textContent = c.label;
    el.catSel.appendChild(o);
  }
  el.catSel.value = 'must';
}
function currentCat() { return catOf(el.catSel.value) || CATS[0]; }
function paintPanelCat() {
  const c = currentCat();
  el.catSel.style.borderColor = c.color;
}
el.catSel.addEventListener('change', paintPanelCat);
function resetDateDefault() { el.dateInput.value = todayStr(); }

el.entryForm.addEventListener('submit', e => {
  e.preventDefault();
  if (!canRecord()) { toast('请先在上方完成发薪状态设置'); return; }

  const amt = parseFloat(el.amtInput.value);
  if (!isFinite(amt) || amt <= 0) { toast('请输入正确的金额'); el.amtInput.focus(); return; }
  if (amt > 9999999) { toast('金额过大'); return; }

  const cat = el.catSel.value;
  const note = el.noteInput.value.trim();
  const dateStr = el.dateInput.value || todayStr();
  const ts = tsFromDate(dateStr);
  const belongsToCurMonth = monthKeyOfTs(ts) === state.monthKey;
  const mode = state.mode === 'wallet' ? 'wallet' : 'grid';
  const amtR = R2(amt);

  const entry = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), cat, amount: amtR, note, ts, date: dateStr, m: mode, dc: false };

  if (mode === 'wallet' && belongsToCurMonth) {
    // 钱包模式·本月消费：立即从总资产池扣减（跨月补记/预记不提前扣池）
    state.saving = R2(state.saving - amtR);
    entry.dc = true;
  }
  state.entries.push(entry);
  save();
  refreshBoard();

  if (belongsToCurMonth) openSheet(cat); // 本月记录：自动打开该分类明细核对
  else toast(`已记录 ${yuan(amtR)}（日期 ${dateStr}）`);

  el.amtInput.value = '';
  el.noteInput.value = '';
  resetDateDefault();
  paintPanelCat();
  if (belongsToCurMonth) toast(`已记录 ${yuan(amtR)}`);
});

/* ================= 直接储蓄浮层 ================= */
function openDepOverlay() {
  closePanel(true);
  el.depAmount.value = '';
  el.depNote.value = '';
  setTimeout(() => { try { el.depAmount.focus(); } catch (e) {} }, 60);
  show(el.depOverlay);
}
el.btnDirectSave.addEventListener('click', openDepOverlay);
el.btnCloseDep.addEventListener('click', () => hide(el.depOverlay));
el.depForm.addEventListener('submit', e => {
  e.preventDefault();
  if (!state.init) { toast('请先完成发薪状态设置'); return; }
  const amt = parseFloat(el.depAmount.value);
  if (!isFinite(amt) || amt <= 0) { toast('请输入正确的金额'); el.depAmount.focus(); return; }
  if (amt > 9999999) { toast('金额过大'); return; }
  const note = el.depNote.value.trim() || '直接储蓄';
  const r = R2(amt);
  state.saving = R2(state.saving + r);
  state.saveOps.push({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), amount: r, note, ts: Date.now() });
  if (state.saveOps.length > 80) state.saveOps = state.saveOps.slice(-80);
  save();
  hide(el.depOverlay);
  refreshBoard();
  toast(`已存入储蓄池 ${yuan(r)}${note !== '直接储蓄' ? '（' + note + '）' : ''}`);
});

/* ================= 目标管理浮层 ================= */
function openGoalOverlay() {
  closePanel(true);
  el.goalName.value = '';
  el.goalTarget.value = '';
  renderGoalList();
  show(el.goalOverlay);
}
el.btnGoalMgr.addEventListener('click', openGoalOverlay);
el.btnCloseGoal.addEventListener('click', () => hide(el.goalOverlay));
el.goalForm.addEventListener('submit', e => {
  e.preventDefault();
  const name = el.goalName.value.trim();
  const target = parseFloat(el.goalTarget.value);
  if (!name) { toast('给目标起个名字吧'); return; }
  if (!isFinite(target) || target <= 0) { toast('请输入正确的目标金额'); return; }
  if (target > 99999999) { toast('金额过大'); return; }
  if (state.goals.some(g => g.name === name)) { toast('已存在同名目标'); return; }
  state.goals.push({ id: 'g' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), name, target: R2(target) });
  save();
  renderGoalList();
  el.goalName.value = '';
  el.goalTarget.value = '';
  refreshBoard();
  toast(`已添加目标「${name}」`);
});

// 目标管理浮层里的预设模板（填充表单）
document.querySelectorAll('.goal-tpl').forEach(btn => {
  btn.addEventListener('click', () => {
    el.goalName.value = btn.dataset.name;
    el.goalTarget.value = btn.dataset.target;
    setTimeout(() => el.goalTarget.focus(), 40);
  });
});

/* ================= 每月自动结算 / 开启新月 =================
   纯前端无法后台定时 → 打开页面时比对月份：
   · 方格模式：上个月 工资 − 方格支出 = 结余（正→并入储蓄池；负→从储蓄池补差）
   · 钱包模式：无方格、消费已实时扣池，跨月不动池子
   ==================================================== */
function rollMonth() {
  if (!state.init) { state.monthKey = curMonthKey(); return null; }
  if (!state.monthKey) { state.monthKey = curMonthKey(); save(); return null; }

  const nowM = curMonthKey();
  if (state.monthKey === nowM) return null;

  const closing = state.monthKey;

  if (state.mode === 'grid' && state.salary != null) {
    // 月结净入池 = 工资 − 当月“真实消费”。
    // 迁移自 v1 的 sv（旧版手动储蓄）已随消费出现在方格中，这里先从消费里
    // 剔出来再入池，等价于“sv + 白格结余”一次算清，避免重复计入储蓄池。
    const closingAll = gridSpentOfMonth(closing);
    const closingSv = sumAmt(
      state.entries.filter(e => monthKeyOfTs(e.ts) === closing && e.m === 'grid' && e.sv)
    );
    const spentReal = R2(closingAll - closingSv);
    const surplus = R2((state.salary || 0) - spentReal);

    state.saving = R2(state.saving + surplus);
    state.settleHist.push({ month: closing, amount: surplus });
    if (state.settleHist.length > 24) state.settleHist = state.settleHist.slice(-24);
    state.monthKey = nowM;
    save();
    return { closing, surplus, wallet: false, noBudget: false };
  }

  // 钱包模式（无月结、消费已实时扣池）或“方格工资未设”的退化态
  state.monthKey = nowM;
  save();
  return {
    closing,
    wallet: state.mode === 'wallet',
    noBudget: state.mode === 'grid',
    surplus: 0,
  };
}

function showSettleNotice(res) {
  if (!res) return;
  if (res.wallet) {
    el.noticeTitle.textContent = '📅 已开启新的一月';
    el.noticeBody.innerHTML =
      `${labelMonth(res.closing)} 是<b>钱包模式</b>，消费已实时从储蓄池扣除，无需月末结算。<br>` +
      `本日已开启 <b>${labelMonth(state.monthKey)}</b>，总资产池余额 <b>${yuan(state.saving)}</b> 保持不变。<br>` +
      `新工资到手后，点储蓄卡「＋ 直接储蓄」把收入转入池中即可。`;
  } else if (res.noBudget) {
    el.noticeTitle.textContent = '📅 已开启新的一月';
    el.noticeBody.innerHTML =
      `${labelMonth(res.closing)} 尚未设置方格工资，无需结算。<br>` +
      `请为本月填写税后工资，生成新方格开始记账。`;
  } else if (res.surplus >= 0) {
    el.noticeTitle.textContent = '🎉 上月方格已自动结算';
    el.noticeBody.innerHTML =
      `${labelMonth(res.closing)} 方格剩余 <b>${yuan(res.surplus)}</b> 已自动并入「储蓄 · 总资产池」（现余额 ${yuan(state.saving)}）。<br>` +
      `已开启 <b>${labelMonth(state.monthKey)}</b>，并沿用上月工资 ${yuan(state.salary)} 生成新方格（可点「修改」调整）。`;
  } else {
    el.noticeTitle.textContent = '⚠️ 上月超支，已从储蓄池补差';
    el.noticeBody.innerHTML =
      `${labelMonth(res.closing)} 方格花超了 <b>${yuan(-res.surplus)}</b>，已自动从储蓄池扣除（现余额 ${yuan(state.saving)}）。<br>` +
      `已开启 <b>${labelMonth(state.monthKey)}</b>，并沿用上月工资 ${yuan(state.salary)} 生成新方格。注意控制非必须消费！`;
  }
  show(el.noticeOverlay);
}

/* ================= 菜单 / 说明 ================= */
el.btnMenu.addEventListener('click', () => show(el.menuOverlay));
el.miPay.addEventListener('click', () => { hide(el.menuOverlay); openPayOverlay(true); });
el.miDirectSave.addEventListener('click', () => { hide(el.menuOverlay); openDepOverlay(); });
el.miGoalMgr.addEventListener('click', () => { hide(el.menuOverlay); openGoalOverlay(); });
el.miSalary.addEventListener('click', () => {
  hide(el.menuOverlay);
  if (state.mode === 'wallet') {
    toast('钱包模式没有方格工资；可在「本月发薪状态」切换为方格模式');
    return;
  }
  if (!state.salary) { openPayOverlay(true); return; }
  startSalaryEdit();
});
el.miHow.addEventListener('click', () => { hide(el.menuOverlay); show(el.howOverlay); });

el.miReset.addEventListener('click', () => {
  hide(el.menuOverlay);
  const cur = monthEntries();
  if (!cur.length) { toast('本月还没有记录'); return; }
  if (!confirm(`确定清空本月（${labelMonth(state.monthKey)}）的全部记录吗？此操作不可撤销。`)) return;
  // 钱包模式下清掉的本月消费要从储蓄池退回（曾实时扣减过的 dc 记录）
  const refund = sumAmt(cur.filter(e => e.dc));
  state.saving = R2(state.saving + refund);
  const curIds = new Set(cur.map(e => e.id));
  state.entries = state.entries.filter(e => !curIds.has(e.id));
  undoItem = null;
  save();
  refreshBoard();
  toast('已清空本月记录');
});

el.miResetAll.addEventListener('click', () => {
  hide(el.menuOverlay);
  if (!confirm('确定要清空所有本地数据和记录吗？此操作不可恢复！')) return;
  localStorage.clear();   // 清空所有数据（v1/v2）
  location.reload();      // 回到最初始：会再次弹出“本月发薪状态”
});

el.btnCloseSheet.addEventListener('click', () => hide(el.sheetOverlay));
el.btnCloseHow.addEventListener('click', () => hide(el.howOverlay));
el.btnCloseNotice.addEventListener('click', () => hide(el.noticeOverlay));

const dismissables = [el.sheetOverlay, el.menuOverlay, el.howOverlay, el.noticeOverlay, el.depOverlay, el.goalOverlay];
dismissables.forEach(ov => {
  ov.addEventListener('click', e => { if (e.target === ov) hide(ov); });
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    hide(el.sheetOverlay); hide(el.menuOverlay); hide(el.howOverlay);
    hide(el.noticeOverlay); hide(el.depOverlay); hide(el.goalOverlay);
    if (payReopen) closePayOverlay();
    closePanel(true);
  }
});

/* ================= Toast ================= */
let toastTimer = null;
function toast(msg, opts = {}) {
  el.toast.hidden = false;
  el.toast.innerHTML = '';
  el.toast.appendChild(document.createTextNode(msg));
  if (opts.undo) {
    const b = document.createElement('button');
    b.className = 'undobtn';
    b.textContent = '撤销';
    b.addEventListener('click', () => { undoDelete(); hideToast(); });
    el.toast.appendChild(b);
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, opts.undo ? 4000 : 2400);
}
function hideToast() { el.toast.hidden = true; }

/* ================= 工具 ================= */
function show(node) { if (node) node.hidden = false; }
function hide(node) { if (node) node.hidden = true; }
function save() { persistState(state); }

let rzTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(rzTimer);
  rzTimer = setTimeout(layout, 120);
});

/* ================= 启动 ================= */
buildCatOptions();
paintPanelCat();
resetDateDefault();

if (state.init) {
  const res = rollMonth();               // 跨月 → 自动结算并开启新月
  applyBoardViews();                     // 以（结算后的）本月状态渲染
  if (res) showSettleNotice(res);
} else {
  applyBoardViews();
  openPayOverlay(false);                 // 首次（或重置后）：弹出“本月发薪状态”
}

if (state.init && canRecord() && !el.board.hidden) {
  layout();
  requestAnimationFrame(() => requestAnimationFrame(layout));
}

// PWA：注册 Service Worker（仅 http/https 环境下有效，file:// 自动跳过）
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
