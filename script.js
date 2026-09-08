/* =========================================================
   方格记账 · 核心逻辑
   纯前端 · localStorage 持久化 · 按月自动结算
   分类顺序（合并块/图例统一）：固定 → 必须 → 非必须 → 会员
   ========================================================= */
'use strict';

/* ---------------- 分类定义 ---------------- */
const CATS = [
  { key: 'fixed',    label: '固定',   color: '#4A90E2', dark: '#2E69B6',
    chips: ['房租', '话费', '储蓄', '长期目标'] },
  { key: 'must',     label: '必须',   color: '#F5A623', dark: '#C67A06',
    chips: ['吃饭', '通勤', '日常消耗', '书籍课程'] },
  { key: 'optional', label: '非必须', color: '#EF5350', dark: '#C62F2F',
    chips: ['奶茶', '咖啡', '大餐', '冲动玩具'] },
  { key: 'member',   label: '会员',   color: '#4CAF50', dark: '#2E8A3D',
    chips: ['视频年费', '购物会员', 'App订阅'] },
];
const catOf = k => CATS.find(c => c.key === k);

/* ---------------- 存储 ---------------- */
const KEY = 'fg_ledger_v1';
function loadData() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (d && typeof d === 'object') {
        const salary = Number(d.salary) || null;
        const entries = Array.isArray(d.entries) ? d.entries : [];
        const monthKey = typeof d.monthKey === 'string' ? d.monthKey : null;
        return { salary, entries, monthKey };
      }
    }
  } catch (e) { /* 忽略损坏数据 */ }
  return { salary: null, entries: [], monthKey: null };
}
let state = loadData();

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
// 根据所选日期 + 当前时刻合成时间戳（保证属于所选的那一天）
function tsFromDate(dateStr) {
  const n = new Date();
  const d = new Date(dateStr + 'T00:00:00');
  d.setHours(n.getHours(), n.getMinutes(), n.getSeconds(), 0);
  return d.getTime();
}
// 某个月（YYYY-MM）最后一刻的时间戳
function endOfMonthTs(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m, 0, 23, 59, 59, 999).getTime();
}
const fmtTime = ts => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/* ---------------- 月份视图的数据 ---------------- */
// 方格 / 统计 / 图例 只看“当前结算月”的记录
function currentEntries() {
  if (!state.monthKey) return state.entries;
  return state.entries.filter(e => monthKeyOfTs(e.ts) === state.monthKey);
}
function sumCat(cat) {
  return currentEntries().filter(e => e.cat === cat).reduce((s, e) => s + e.amount, 0);
}
function totalSpent() { return currentEntries().reduce((s, e) => s + e.amount, 0); }
// 储蓄里程碑 = 所有历史月份「固定·储蓄」累计（含每月自动结算）
function sumSaved() {
  return state.entries.filter(e => e.cat === 'fixed' && e.save).reduce((s, e) => s + e.amount, 0);
}

/* ---------------- DOM ---------------- */
const $ = id => document.getElementById(id);
const el = {
  salarySet: $('salarySet'), salaryView: $('salaryView'),
  salaryForm: $('salaryForm'), salaryInput: $('salaryInput'),
  salarySetHint: $('salarySetHint'), btnCancelSalary: $('btnCancelSalary'),
  salaryNum: $('salaryNum'), salaryTotal: $('salaryTotal'),
  btnChangeSalary: $('btnChangeSalary'), btnMenu: $('btnMenu'),

  board: $('board'), intro: $('intro'),
  statIncome: $('statIncome'), statSpent: $('statSpent'), statRemain: $('statRemain'),

  legend: $('legend'), grid: $('grid'), gridHint: $('gridHint'), emptyTip: $('emptyTip'),

  savedNow: $('savedNow'), goalText: $('goalText'), goalPct: $('goalPct'),
  savingsFill: $('savingsFill'), savingsTrack: $('savingsTrack'), achieved: $('achieved'),

  entryForm: $('entryForm'), catSel: $('catSel'), amtInput: $('amtInput'),
  dateInput: $('dateInput'), noteInput: $('noteInput'), chipRow: $('chipRow'),
  saveWrap: $('saveWrap'), saveCheck: $('saveCheck'), addBtn: $('addBtn'),

  sheetOverlay: $('sheetOverlay'), sheetDot: $('sheetDot'), sheetTitle: $('sheetTitle'),
  sheetCount: $('sheetCount'), sheetSum: $('sheetSum'),
  sheetList: $('sheetList'), sheetEmpty: $('sheetEmpty'), btnCloseSheet: $('btnCloseSheet'),

  menuOverlay: $('menuOverlay'), miSalary: $('miSalary'), miReset: $('miReset'),
  miResetAll: $('miResetAll'), miHow: $('miHow'),
  howOverlay: $('howOverlay'), btnCloseHow: $('btnCloseHow'),

  noticeOverlay: $('noticeOverlay'), noticeTitle: $('noticeTitle'),
  noticeBody: $('noticeBody'), btnCloseNotice: $('btnCloseNotice'),

  toast: $('toast'),
};

/* ---------------- 基础状态 ---------------- */
let totalCells = cellsForSalary(state.salary || 0);
let cellNodes = [];
let cols = 24;
let openCat = null;      // 当前打开的分类明细
let undoItem = null;     // 单步撤销

/* ================= 方格渲染 ================= */
function layout() {
  if (!el.board.hidden) {
    const w = el.grid.clientWidth;
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
function paintGrid() {
  const n = totalCells;
  const noLine = 'none';
  const line = 'inset 0 0 0 1px rgba(0,0,0,0.03)';
  let ptr = 0;

  // 按固定顺序把当前月每个分类涂成连续方块（同类自动合并）
  for (const c of CATS) {
    const want = currentEntries()
      .filter(e => e.cat === c.key)
      .reduce((s, e) => s + cellOf(e.amount), 0);
    const take = Math.min(want, n - ptr);
    for (let i = ptr; i < ptr + take; i++) {
      const node = cellNodes[i];
      if (node._cat !== c.key) {
        node._cat = c.key;
        node.style.background = c.color;
        node.style.boxShadow = noLine;
        node.dataset.cat = c.key;
      }
    }
    ptr += take;
    if (ptr >= n) break;
  }
  // 剩余格子 = 纯白
  for (let i = ptr; i < n; i++) {
    const node = cellNodes[i];
    if (node._cat !== '') {
      node._cat = '';
      node.style.background = 'rgb(255, 255, 255)';
      node.style.boxShadow = line;
      delete node.dataset.cat;
    }
  }
}

el.grid.addEventListener('click', e => {
  const cell = e.target.closest('.cell');
  if (!cell) return;
  const cat = cell.dataset.cat;
  if (cat) openSheet(cat);
  else {
    const remain = (state.salary || 0) - totalSpent();
    toast(remain > 0 ? `白色格 = 本月剩余可用 ${yuan(remain)}` : '本月工资格已全部用完');
  }
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
  const list = currentEntries()
    .filter(e => e.cat === openCat)
    .sort((a, b) => b.ts - a.ts);
  el.sheetCount.textContent = `${list.length} 笔`;
  el.sheetSum.textContent = yuan(list.reduce((s, e) => s + e.amount, 0));
  el.sheetSum.style.color = catOf(openCat).color;

  el.sheetList.innerHTML = '';
  el.sheetEmpty.hidden = list.length !== 0;
  el.sheetEmpty.textContent = state.monthKey ? `本月（${labelMonth(state.monthKey)}）该分类还没有记录` : '该分类下还没有记录';

  for (const e of list) {
    const li = document.createElement('li');
    li.className = 'sheet-item';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const nt = document.createElement('div');
    nt.className = 'nt';
    nt.textContent = e.note || '(未填写备注)';
    if (e.save) {
      const tag = document.createElement('span');
      tag.className = 'tag-save';
      tag.textContent = '储蓄';
      nt.appendChild(tag);
    }
    if (e.auto) {
      const tag = document.createElement('span');
      tag.className = 'tag-save';
      tag.style.cssText = 'color:#B4660A;background:rgba(245,166,35,.16)';
      tag.textContent = '自动结算';
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
  undoItem = state.entries[i];
  state.entries.splice(i, 1);
  save();
  refreshAll();
  toast('已删除', { undo: true });
}
function undoDelete() {
  if (!undoItem) return;
  state.entries.push(undoItem);
  undoItem = null;
  save();
  refreshAll();
  toast('已恢复该笔记录');
}

/* ================= 储蓄里程碑 ================= */
const MILESTONES = [10000, 20000, 50000, 100000, 200000, 500000, 1000000, 2000000];
function updateSavings() {
  const saved = sumSaved();
  el.savedNow.textContent = yuan(saved);

  const next = MILESTONES.find(m => m > saved) || MILESTONES[MILESTONES.length - 1];
  const pct = Math.min(100, Math.max(0, (saved / next) * 100));

  el.goalText.innerHTML = saved < next
    ? `距 ${yuan(next)} 还差 <b>${yuan(next - saved)}</b>`
    : `<b>向 ${yuan(next)} 发起冲刺</b>`;
  el.goalPct.textContent = Math.round(pct) + '%';
  el.savingsTrack.setAttribute('aria-valuenow', Math.round(pct));
  el.savingsFill.style.width = pct + '%';
  el.savingsFill.classList.remove('s1', 's2', 's3', 'done');
  el.savingsFill.classList.add(pct >= 100 ? 'done' : pct >= 80 ? 's3' : pct >= 45 ? 's2' : 's1');

  el.achieved.innerHTML = '';
  for (const m of MILESTONES) {
    if (m <= saved) {
      const chip = document.createElement('span');
      chip.className = 'ach-chip';
      chip.textContent = `达成 ${yuan(m)} ✓`;
      el.achieved.appendChild(chip);
    } else break;
  }
}

/* ================= 顶部统计 ================= */
function refreshStats() {
  const salary = state.salary || 0;
  const spent = totalSpent();
  const remain = salary - spent;
  el.statIncome.textContent = yuan(salary);
  el.statSpent.textContent = yuan(spent);
  el.statRemain.textContent = remain < 0 ? '-' + yuan(-remain) : yuan(remain);
  el.statRemain.closest('.stat').classList.toggle('oflow', remain < 0);
}

/* ================= 主刷新 ================= */
function refreshAll() {
  if (!state.salary) return;

  const newCells = cellsForSalary(state.salary);
  if (newCells !== totalCells || cellNodes.length !== totalCells) {
    totalCells = newCells;
    buildCells();
  }
  layout();

  el.salaryNum.textContent = money(state.salary);
  el.salaryTotal.textContent = `${totalCells} 格`;
  el.gridHint.textContent =
    `本月 ${labelMonth(state.monthKey)} · 每格 ${cellCost} 元 · 共 ${totalCells} 格 · ` +
    `同类连成大方块（固定→必须→非必须→会员），点色块看明细，点白格看剩余`;

  refreshStats();
  renderLegend();
  paintGrid();
  updateSavings();

  el.emptyTip.hidden = currentEntries().length !== 0;

  if (openCat) renderSheet();
}

/* ================= 视图切换 ================= */
function applySalaryMode() {
  const has = !!state.salary;
  hide(el.salarySet); hide(el.salaryView); hide(el.board); hide(el.intro); hide(el.entryForm);
  hide(el.btnCancelSalary);
  document.body.classList.toggle('has-panel', has);
  if (has) {
    show(el.salaryView);
    show(el.board);
    show(el.entryForm);
    refreshAll();
  } else {
    show(el.salarySet);
    show(el.intro);
  }
}

el.salaryForm.addEventListener('submit', e => {
  e.preventDefault();
  setSalary(parseFloat(el.salaryInput.value));
});
el.btnChangeSalary.addEventListener('click', () => startSalaryEdit());
el.btnCancelSalary.addEventListener('click', () => applySalaryMode());
function startSalaryEdit() {
  hide(el.salaryView);
  show(el.salarySet);
  show(el.btnCancelSalary);
  el.salaryInput.value = state.salary || '';
  setTimeout(() => { el.salaryInput.focus(); el.salaryInput.select(); }, 60);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function setSalary(v) {
  if (!isFinite(v) || v <= 0) { toast('请输入正确的月薪金额'); return; }
  if (v > 200000) { toast('请输入 ≤ 200,000 的月薪'); return; }
  state.salary = Math.round(v * 100) / 100;
  if (!state.monthKey) state.monthKey = curMonthKey(); // 首次设置月薪即从本月开始
  save();
  applySalaryMode();
  toast(`已生成 ${cellsForSalary(state.salary)} 个方格`);
}

/* ================= 每月底 24 点自动结算 =================
   纯前端无法后台定时，改为“打开网页时比对月份”：
   若发现上次账期 ≠ 当前月份，把上个月剩余金额存入「固定·储蓄」，
   然后开启新的一月。                                    */
function settleIfMonthChanged() {
  if (!state.salary) return null;

  // 迁移：旧数据没有 monthKey → 以最后一笔记录所在月为当前账期
  if (!state.monthKey) {
    const last = state.entries.reduce((mx, e) => Math.max(mx, e.ts || 0), 0);
    state.monthKey = last ? monthKeyOfTs(last) : curMonthKey();
  }

  const nowM = curMonthKey();
  if (state.monthKey === nowM) return null; // 仍是同一个月，无需结算

  const closing = state.monthKey;
  const spent = state.entries
    .filter(e => monthKeyOfTs(e.ts) === closing)
    .reduce((s, e) => s + e.amount, 0);
  const leftover = Math.max(0, Math.round((state.salary - spent) * 100) / 100);

  if (leftover > 0) {
    state.entries.push({
      id: 'auto-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      cat: 'fixed',
      amount: leftover,
      note: `${labelMonth(closing)} 月末自动结算`,
      save: true,
      auto: true,
      ts: endOfMonthTs(closing),
      date: closing,
    });
  }

  state.monthKey = nowM;
  save();
  return { closing, leftover };
}
function showSettleNotice(res) {
  if (!res) return;
  el.noticeTitle.textContent = res.leftover > 0 ? '🎉 上月已自动结算' : '📅 已开启新的一月';
  el.noticeBody.innerHTML = res.leftover > 0
    ? `${labelMonth(res.closing)} 月底的剩余白格 <b>${yuan(res.leftover)}</b> 已自动存入「固定 · 储蓄」并计入储蓄里程碑。<br>本日已开启 <b>${labelMonth(state.monthKey)}</b> 的全新方格，开始记账吧！`
    : `${labelMonth(res.closing)} 无剩余结余（预算已用满），无需入账。<br>已开启 <b>${labelMonth(state.monthKey)}</b> 的全新方格，开始记账吧！`;
  show(el.noticeOverlay);
}

/* ================= 底部录入面板 ================= */
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

  el.chipRow.innerHTML = '';
  for (const t of c.chips) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = t;
    chip.addEventListener('click', () => {
      el.noteInput.value = t;
      syncChips();
      if (t === '储蓄') el.saveCheck.checked = true;
      else if (el.catSel.value === 'fixed') el.saveCheck.checked = false;
      el.noteInput.focus();
    });
    el.chipRow.appendChild(chip);
  }
  if (el.catSel.value === 'fixed') show(el.saveWrap); else { hide(el.saveWrap); el.saveCheck.checked = false; }
  syncChips();
}
function syncChips() {
  const note = el.noteInput.value.trim();
  [...el.chipRow.children].forEach(ch => {
    const on = note === ch.textContent;
    ch.classList.toggle('sel', on);
    if (on) ch.style.background = currentCat().color;
    else ch.style.background = '';
  });
  if (el.catSel.value === 'fixed' && /储蓄/.test(note)) el.saveCheck.checked = true;
}

el.catSel.addEventListener('change', paintPanelCat);
el.noteInput.addEventListener('input', syncChips);

function resetDateDefault() { el.dateInput.value = todayStr(); }

el.entryForm.addEventListener('submit', e => {
  e.preventDefault();
  if (!state.salary) { toast('请先在上方设置税后月薪'); return; }

  const amt = parseFloat(el.amtInput.value);
  if (!isFinite(amt) || amt <= 0) { toast('请输入正确的金额'); el.amtInput.focus(); return; }
  if (amt > 9999999) { toast('金额过大'); return; }

  const cat = el.catSel.value;
  const note = el.noteInput.value.trim();
  const dateStr = el.dateInput.value || todayStr();
  const isSave = cat === 'fixed' && (el.saveCheck.checked || /储蓄/.test(note));
  const ts = tsFromDate(dateStr);
  const belongsToCurMonth = monthKeyOfTs(ts) === state.monthKey;

  state.entries.push({
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    cat,
    amount: Math.round(amt * 100) / 100,
    note,
    save: isSave,
    ts,
    date: dateStr,
  });
  save();
  refreshAll();

  if (belongsToCurMonth) openSheet(cat); // 本月记录：自动打开该分类明细核对

  el.amtInput.value = '';
  el.noteInput.value = '';
  el.saveCheck.checked = false;
  resetDateDefault();
  paintPanelCat();
  toast(belongsToCurMonth ? `已记录 ${yuan(amt)}` : `已记录 ${yuan(amt)}（日期 ${dateStr}）`);
});

/* ================= 菜单 / 说明 ================= */
el.btnMenu.addEventListener('click', () => show(el.menuOverlay));
el.miSalary.addEventListener('click', () => { hide(el.menuOverlay); startSalaryEdit(); });
el.miHow.addEventListener('click', () => { hide(el.menuOverlay); show(el.howOverlay); });

el.miReset.addEventListener('click', () => {
  hide(el.menuOverlay);
  const cur = currentEntries();
  if (!cur.length) { toast('本月还没有支出记录'); return; }
  if (!confirm(`确定清空本月（${labelMonth(state.monthKey)}）的全部记录吗？此操作不可撤销。`)) return;
  const curIds = new Set(cur.map(e => e.id));
  state.entries = state.entries.filter(e => !curIds.has(e.id));
  undoItem = null;
  save();
  refreshAll();
  toast('已清空本月支出');
});

el.miResetAll.addEventListener('click', () => {
  hide(el.menuOverlay);
  if (!confirm('确定要清空所有本地数据和记录吗？此操作不可恢复！')) return;
  localStorage.clear();   // 清空 localStorage 所有数据
  location.reload();      // 刷新回到最初始状态
});

el.btnCloseSheet.addEventListener('click', () => hide(el.sheetOverlay));
el.btnCloseHow.addEventListener('click', () => hide(el.howOverlay));
el.btnCloseNotice.addEventListener('click', () => hide(el.noticeOverlay));

[el.sheetOverlay, el.menuOverlay, el.howOverlay, el.noticeOverlay].forEach(ov => {
  ov.addEventListener('click', e => { if (e.target === ov) hide(ov); });
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    hide(el.sheetOverlay); hide(el.menuOverlay);
    hide(el.howOverlay); hide(el.noticeOverlay);
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
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify({
      salary: state.salary,
      monthKey: state.monthKey,
      entries: state.entries,
    }));
  } catch (e) { /* 存储满或不可用 */ }
}

let rzTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(rzTimer);
  rzTimer = setTimeout(layout, 120);
});

/* ================= 启动 ================= */
buildCatOptions();
paintPanelCat();
resetDateDefault();

// 检测跨月 → 自动结算并开启新的一月
const settleRes = settleIfMonthChanged();
applySalaryMode();     // 以（结算后的）本月状态渲染
if (settleRes) showSettleNotice(settleRes); // UI 显示结算完成提示

if (state.salary) {
  layout();
  requestAnimationFrame(() => requestAnimationFrame(layout));
}

// PWA：注册 Service Worker（仅 http/https 环境下有效，file:// 自动跳过）
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
