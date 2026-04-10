const STORAGE_KEY = 'inspection-support-state-v2';

// -----------------------------
// State
// -----------------------------
const state = {
  session: null,
  selectedCustomerId: null,
  mode: 'continuous',
  lastAction: null,
};


// -----------------------------
// DOM Elements
// -----------------------------
const els = {
  fileInput: document.getElementById('fileInput'),
  importSummary: document.getElementById('importSummary'),
  customerList: document.getElementById('customerList'),
  searchCustomer: document.getElementById('searchCustomer'),
  inspectionTitle: document.getElementById('inspectionTitle'),
  overallProgress: document.getElementById('overallProgress'),
  overallStatus: document.getElementById('overallStatus'),
  itemTableWrap: document.getElementById('itemTableWrap'),
  logList: document.getElementById('logList'),
  scanInput: document.getElementById('scanInput'),
  bulkBarcodeInput: document.getElementById('bulkBarcodeInput'),
  bulkQtyInput: document.getElementById('bulkQtyInput'),
  btnApplyBulk: document.getElementById('btnApplyBulk'),
  modeContinuous: document.getElementById('modeContinuous'),
  modeBulk: document.getElementById('modeBulk'),
  continuousBox: document.getElementById('continuousBox'),
  bulkBox: document.getElementById('bulkBox'),
  messageArea: document.getElementById('messageArea'),
  btnUndo: document.getElementById('btnUndo'),
  btnResetSession: document.getElementById('btnResetSession'),
  btnBackToList: document.getElementById('btnBackToList'),
};


// -----------------------------
// Audio
// -----------------------------
const AudioManager = (() => {
  const sources = {
    start: './assets/audio/start.mp3',
    multipleStart: './assets/audio/multiple_start.mp3',
    error: './assets/audio/error.mp3',
    complete: './assets/audio/complete.mp3',
  };
  const baseAudios = {};

  Object.entries(sources).forEach(([key, src]) => {
    const audio = new Audio(src);
    audio.preload = 'auto';
    baseAudios[key] = audio;
  });

  function play(type) {
    const base = baseAudios[type];
    if (!base) return;
    const audio = base.cloneNode(true);
    audio.currentTime = 0;
    audio.play().catch(() => {});
  }

  return {
    playStart() {
      play('start');
    },
    playMultipleStart() {
      play('multipleStart');
    },
    playError() {
      play('error');
    },
    playComplete() {
      play('complete');
    },
  };
})();


// -----------------------------
// App Lifecycle
// -----------------------------
function init() {
  bindEvents();
  restoreState();
  renderAll();
  focusCurrentInput();
}

function bindEvents() {
  els.fileInput.addEventListener('change', onFileSelected);
  els.searchCustomer.addEventListener('input', renderCustomerList);
  els.modeContinuous.addEventListener('click', () => setMode('continuous'));
  els.modeBulk.addEventListener('click', () => setMode('bulk'));
  els.scanInput.addEventListener('keydown', onContinuousScanKeydown);
  els.btnApplyBulk.addEventListener('click', onApplyBulk);
  els.bulkBarcodeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const barcode = sanitizeBarcode(els.bulkBarcodeInput.value);
      if (!barcode) {
        AudioManager.playError();
        setMessage('バーコードを入力してください。', 'warn');
        return;
      }
      els.bulkQtyInput.focus();
      els.bulkQtyInput.select();
      setMessage('数量を入力して Enter で登録してください。', 'info');
    }
  });
  els.bulkQtyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onApplyBulk();
    }
  });
  els.btnUndo.addEventListener('click', undoLastAction);
  els.btnResetSession.addEventListener('click', resetSession);
  els.btnBackToList.addEventListener('click', () => {
    state.selectedCustomerId = null;
    clearInspectionInputs();
    renderAll();
  });
}

function restoreState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.session) {
      state.session = parsed.session;
      state.selectedCustomerId = parsed.selectedCustomerId || null;
      state.mode = parsed.mode || 'continuous';
      state.session.customerOrder.forEach((customerId) => {
        const customer = state.session.customers[customerId];
        if (customer) refreshCustomerStatus(customer);
      });
      if (!state.session.customers[state.selectedCustomerId]) {
        state.selectedCustomerId = null;
      }
    }
  } catch (error) {
    console.error('restoreState failed', error);
  }
}

function persistState() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      session: state.session,
      selectedCustomerId: state.selectedCustomerId,
      mode: state.mode,
    })
  );
}

async function onFileSelected(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    const rows = await readFileRows(file);
    const session = buildSessionFromRows(rows, file.name);
    state.session = session;
    state.selectedCustomerId = session.customerOrder[0] || null;
    state.lastAction = null;
    persistState();
    renderAll();
    setMessage(`「${file.name}」を読み込みました。`, 'ok');
  } catch (error) {
    console.error(error);
    setMessage(`読込に失敗しました: ${error.message}`, 'error');
  } finally {
    els.fileInput.value = '';
  }
}


// -----------------------------
// Import
// -----------------------------
function readFileRows(file) {
  const name = String(file.name || '').toLowerCase();
  if (name.endsWith('.csv')) {
    return readCsvRows(file);
  }
  return readExcelRows(file);
}

function readCsvRows(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = reader.result;
        const workbook = XLSX.read(text, { type: 'string' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        resolve(rows);
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = () => reject(new Error('CSVファイルの読込に失敗しました。'));
    reader.readAsText(file, 'utf-8');
  });
}

function readExcelRows(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = reader.result;
        const workbook = XLSX.read(data, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        resolve(rows);
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = () => reject(new Error('Excelファイルの読込に失敗しました。'));
    reader.readAsArrayBuffer(file);
  });
}

function buildSessionFromRows(rows, fileName = 'sample') {
  if (!Array.isArray(rows) || rows.length < 2) {
    throw new Error('ヘッダ行とデータ行が必要です。');
  }

  const header = rows[0].map(v => normalizeHeader(v));
  const groupCodeIdx = findHeaderIndex(header, ['合梱注文コード']);
  const supplierNameIdx = findHeaderIndex(header, ['仕入先名', '仕入先']);
  const barcodeIdx = findHeaderIndex(header, ['バーコード', 'jan', 'janコード', 'barcode', '商品代替コード']);
  const itemNameIdx = findHeaderIndex(header, ['品名', '商品', '商品コード']);
  const qtyIdx = findHeaderIndex(header, ['数量', '予定数', '出荷数', '予定数量']);

  if ([groupCodeIdx, barcodeIdx, itemNameIdx, qtyIdx].some(idx => idx < 0)) {
    throw new Error('必要列が見つかりません。想定列名を確認してください。');
  }

  const customers = {};
  rows.slice(1).forEach((row) => {
    const groupCode = String(row[groupCodeIdx] || '').trim();
    const supplierName = supplierNameIdx >= 0 ? String(row[supplierNameIdx] || '').trim() : '';
    const barcode = sanitizeBarcode(row[barcodeIdx]);
    const itemName = String(row[itemNameIdx] || '').trim() || '名称未設定';
    const plannedQty = toPositiveInt(row[qtyIdx]);

    if (!groupCode || !barcode || plannedQty <= 0) return;

    const customerId = groupCode;
    if (!customers[customerId]) {
      customers[customerId] = {
        id: customerId,
        groupCode,
        supplierName,
        name: groupCode,
        itemsByBarcode: {},
        scanLogs: [],
        status: 'todo',
      };
    }
    if (!customers[customerId].supplierName && supplierName) {
      customers[customerId].supplierName = supplierName;
    }

    if (!customers[customerId].itemsByBarcode[barcode]) {
      customers[customerId].itemsByBarcode[barcode] = {
        barcode,
        itemName,
        plannedQty: 0,
        checkedQty: 0,
        lastScannedAt: null,
      };
    }

    customers[customerId].itemsByBarcode[barcode].plannedQty += plannedQty;
  });

  const customerOrder = Object.keys(customers);
  if (customerOrder.length === 0) {
    throw new Error('有効なデータ行がありませんでした。');
  }

  customerOrder.forEach((customerId) => refreshCustomerStatus(customers[customerId]));

  return {
    id: `session_${Date.now()}`,
    fileName,
    createdAt: new Date().toISOString(),
    customers,
    customerOrder,
  };
}

function normalizeHeader(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '');
}

function findHeaderIndex(header, aliases) {
  const normalizedAliases = aliases.map(v => normalizeHeader(v));
  return header.findIndex(col => normalizedAliases.includes(col));
}

function sanitizeBarcode(value) {
  return String(value || '').trim().replace(/[^0-9A-Za-z_-]/g, '');
}

function toPositiveInt(value) {
  const num = Number(String(value).trim());
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.floor(num));
}


// -----------------------------
// Render
// -----------------------------
function setMode(mode) {
  state.mode = mode;
  persistState();
  renderMode();
  focusCurrentInput();
}

function renderAll() {
  renderImportSummary();
  renderCustomerList();
  renderInspection();
  renderMode();
}

function renderImportSummary() {
  if (!state.session) {
    els.importSummary.className = 'summary-card empty';
    els.importSummary.textContent = '検品データが未読込です。ファイルを選択してください。';
    return;
  }
  const customerCount = state.session.customerOrder.length;
  const itemCount = state.session.customerOrder.reduce((sum, customerId) => {
    const customer = state.session.customers[customerId];
    return sum + Object.keys(customer.itemsByBarcode).length;
  }, 0);
  els.importSummary.className = 'summary-card';
  els.importSummary.innerHTML = `
    <div><strong>ファイル:</strong> ${escapeHtml(state.session.fileName)}</div>
    <div><strong>卸先数:</strong> ${customerCount}</div>
    <div><strong>JAN行数(集約後):</strong> ${itemCount}</div>
    <div><strong>作成日時:</strong> ${formatDateTime(state.session.createdAt)}</div>
  `;
}

function renderCustomerList() {
  const q = String(els.searchCustomer.value || '').trim().toLowerCase();
  if (!state.session) {
    els.customerList.className = 'customer-list empty';
    els.customerList.textContent = 'データ取込後に卸先一覧が表示されます。';
    return;
  }

  const cards = state.session.customerOrder
    .map(id => state.session.customers[id])
    .filter((customer) => {
      if (!q) return true;
      const groupCode = String(customer.groupCode || customer.name || '').toLowerCase();
      const supplierName = String(customer.supplierName || '').toLowerCase();
      return groupCode.includes(q) || supplierName.includes(q);
    })
    .map(customer => createCustomerCard(customer))
    .join('');

  els.customerList.className = 'customer-list';
  els.customerList.innerHTML = cards || '<div class="panel-body">該当する卸先がありません。</div>';
  els.customerList.querySelectorAll('[data-customer-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.selectedCustomerId = btn.dataset.customerId;
      clearInspectionInputs();
      persistState();
      renderAll();
      focusCurrentInput();
    });
  });

  els.customerList.querySelectorAll('[data-reset-customer-id]').forEach(btn => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      resetSupplierInspection(btn.dataset.resetCustomerId);
    });
  });
}

function createCustomerCard(customer) {
  const summary = getCustomerSummary(customer);
  const groupCode = customer.groupCode || customer.name || '-';
  const supplierName = customer.supplierName || '-';
  const badgeClass = customer.status === 'done'
    ? 'done'
    : customer.status === 'progress'
      ? 'progress'
      : customer.status === 'diff'
        ? 'diff'
        : 'todo';
  return `
    <article class="customer-card ${state.selectedCustomerId === customer.id ? 'active' : ''}">
      <div class="customer-top">
        <div>
          <div class="customer-name">${escapeHtml(groupCode)}</div>
          <div class="customer-sub">仕入先: ${escapeHtml(supplierName)}</div>
        </div>
        <span class="badge ${badgeClass}">${statusLabel(customer.status)}</span>
      </div>
      <div class="customer-meta">
        <span>商品数: ${summary.itemCount}</span>
        <span>進捗: ${summary.checkedQty} / ${summary.plannedQty}</span>
        <span>読取履歴: ${customer.scanLogs.length}</span>
      </div>
      <div class="customer-actions">
        <button class="btn btn-secondary" data-customer-id="${escapeHtml(customer.id)}" type="button">開く</button>
        <button class="btn btn-danger" data-reset-customer-id="${escapeHtml(customer.id)}" type="button">リセット</button>
      </div>
    </article>
  `;
}

function renderInspection() {
  const customer = getSelectedCustomer();
  if (!customer) {
    els.inspectionTitle.textContent = '卸先を選択すると、ここに検品対象が表示されます。';
    els.overallProgress.textContent = '-';
    els.overallStatus.textContent = '-';
    els.itemTableWrap.className = 'table-wrap empty';
    els.itemTableWrap.textContent = '卸先を選択すると商品一覧が表示されます。';
    els.logList.className = 'log-list empty';
    els.logList.textContent = '読取履歴はまだありません。';
    return;
  }

  const summary = getCustomerSummary(customer);
  const groupCode = customer.groupCode || customer.name || '-';
  const supplierName = customer.supplierName || '-';
  els.inspectionTitle.textContent = `${groupCode}（仕入先: ${supplierName}）`;
  els.overallProgress.textContent = `${summary.checkedQty} / ${summary.plannedQty}`;
  els.overallStatus.textContent = statusLabel(customer.status);
  renderItemTable(customer);
  renderLogs(customer);
}

function renderMode() {
  const isContinuous = state.mode === 'continuous';
  els.modeContinuous.classList.toggle('active', isContinuous);
  els.modeBulk.classList.toggle('active', !isContinuous);
  els.continuousBox.classList.toggle('hidden', !isContinuous);
  els.bulkBox.classList.toggle('hidden', isContinuous);
}

function renderItemTable(customer) {
  const items = Object.values(customer.itemsByBarcode).sort((a, b) => {
    const aTime = a.lastScannedAt ? new Date(a.lastScannedAt).getTime() : 0;
    const bTime = b.lastScannedAt ? new Date(b.lastScannedAt).getTime() : 0;
    if (aTime !== bTime) return bTime - aTime;
    return a.barcode.localeCompare(b.barcode);
  });
  const latestScannedTime = items.reduce((latest, item) => {
    const time = item.lastScannedAt ? new Date(item.lastScannedAt).getTime() : 0;
    return Math.max(latest, time);
  }, 0);
  if (items.length === 0) {
    els.itemTableWrap.className = 'table-wrap empty';
    els.itemTableWrap.textContent = '商品がありません。';
    return;
  }
  const rows = items.map(item => {
    const isDone = item.checkedQty === item.plannedQty;
    const isOver = item.checkedQty > item.plannedQty;
    const isUnread = item.checkedQty === 0;
    const isInProgress = item.checkedQty > 0 && item.checkedQty < item.plannedQty;
    const isRecent = latestScannedTime > 0
      && item.lastScannedAt
      && new Date(item.lastScannedAt).getTime() === latestScannedTime;

    let rowClass = 'row-unread';
    if (isOver) rowClass = 'row-over';
    else if (isRecent) rowClass = 'row-recent';
    else if (isDone) rowClass = 'row-complete';
    else if (isInProgress) rowClass = 'row-progress';

    let pillClass = 'unread';
    if (isOver) pillClass = 'over';
    else if (isDone) pillClass = 'done';
    else if (isInProgress) pillClass = 'progress';

    return `
      <tr class="${rowClass}">
        <td>${escapeHtml(item.barcode)}</td>
        <td>${escapeHtml(item.itemName)}</td>
        <td><span class="qty-pill ${pillClass}">${item.checkedQty} / ${item.plannedQty}</span></td>
      </tr>
    `;
  }).join('');

  els.itemTableWrap.className = 'table-wrap';
  els.itemTableWrap.innerHTML = `
    <table class="table">
      <thead>
        <tr>
          <th>バーコード</th>
          <th>商品名</th>
          <th>進捗</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderLogs(customer) {
  const logs = [...customer.scanLogs].reverse();
  if (logs.length === 0) {
    els.logList.className = 'log-list empty';
    els.logList.textContent = '読取履歴はまだありません。';
    return;
  }
  els.logList.className = 'log-list';
  els.logList.innerHTML = logs.map(log => `
    <div class="log-item">
      <div class="log-row">
        <div class="log-label">時刻</div>
        <div class="log-value">${formatDateTime(log.at)}</div>
      </div>
      <div class="log-row">
        <div class="log-label">読取</div>
        <div class="log-value log-main">${escapeHtml(log.barcode)} / +${log.qty}</div>
      </div>
      <div class="log-row">
        <div class="log-label">種別</div>
        <div class="log-value">${log.mode === 'bulk' ? '一括' : '連続'}</div>
      </div>
      <div class="log-row">
        <div class="log-label">商品名</div>
        <div class="log-value">${escapeHtml(log.itemName || '商品不明')}</div>
      </div>
    </div>
  `).join('');
}


// -----------------------------
// Scan Operations
// -----------------------------
function onContinuousScanKeydown(event) {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const barcode = sanitizeBarcode(els.scanInput.value);
  if (!barcode) return;
  applyScan(barcode, 1, 'continuous');
  els.scanInput.value = '';
}

function onApplyBulk() {
  const barcode = sanitizeBarcode(els.bulkBarcodeInput.value);
  const qty = toPositiveInt(els.bulkQtyInput.value);
  if (!barcode) {
    AudioManager.playError();
    setMessage('バーコードを入力してください。', 'warn');
    return;
  }
  if (qty <= 0) {
    AudioManager.playError();
    setMessage('数量は1以上を入力してください。', 'warn');
    return;
  }
  applyScan(barcode, qty, 'bulk');
  els.bulkBarcodeInput.value = '';
  els.bulkQtyInput.value = '1';
  focusCurrentInput();
}

function applyScan(barcode, qty, mode) {
  const customer = getSelectedCustomer();
  if (!customer) {
    AudioManager.playError();
    setMessage('先に卸先を選択してください。', 'warn');
    return;
  }

  const item = customer.itemsByBarcode[barcode];
  if (!item) {
    AudioManager.playError();
    setMessage(`バーコード ${barcode} はこの卸先に存在しません。`, 'error');
    return;
  }

  const beforeQty = item.checkedQty;
  const nextQty = beforeQty + qty;
  if (nextQty > item.plannedQty) {
    AudioManager.playError();
    setMessage(`数量超過のため受理できません: ${item.itemName} は ${beforeQty} / ${item.plannedQty} です。`, 'warn');
    return;
  }

  const previousStatus = customer.status;
  item.checkedQty = nextQty;
  const log = {
    id: `log_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    barcode,
    qty,
    mode,
    at: new Date().toISOString(),
    itemName: item.itemName,
  };
  customer.scanLogs.push(log);
  item.lastScannedAt = log.at;
  state.lastAction = {
    customerId: customer.id,
    barcode,
    qty,
    logId: log.id,
    beforeQty,
  };

  refreshCustomerStatus(customer);
  persistState();
  renderAll();

  if (mode === 'continuous') {
    AudioManager.playStart();
  } else {
    AudioManager.playMultipleStart();
  }
  setMessage(`${item.itemName} を +${qty} しました。`, 'ok');

  const becameComplete = previousStatus !== 'done' && customer.status === 'done';
  if (becameComplete) {
    AudioManager.playComplete();
    setMessage(`卸先「${customer.name}」の検品が完了しました。`, 'ok');
  }

  focusCurrentInput();
}

function undoLastAction() {
  if (!state.lastAction || !state.session) {
    setMessage('取り消せる操作がありません。', 'warn');
    return;
  }
  const { customerId, barcode, logId, beforeQty } = state.lastAction;
  const customer = state.session.customers[customerId];
  if (!customer || !customer.itemsByBarcode[barcode]) {
    AudioManager.playError();
    setMessage('直前操作の取消に失敗しました。', 'error');
    return;
  }

  customer.itemsByBarcode[barcode].checkedQty = beforeQty;
  customer.scanLogs = customer.scanLogs.filter(log => log.id !== logId);
  refreshCustomerStatus(customer);
  state.lastAction = null;
  persistState();
  renderAll();
  setMessage('直前の操作を取り消しました。', 'ok');
}


function resetSupplierInspection(supplierId) {
  if (!state.session || !supplierId) return;
  const customer = state.session.customers[supplierId];
  if (!customer) return;

  const ok = confirm('この卸先の検品状態をリセットしますか？ 検品済数と読取履歴が初期化されます。');
  if (!ok) return;

  Object.values(customer.itemsByBarcode).forEach((item) => {
    item.checkedQty = 0;
    item.lastScannedAt = null;
  });
  customer.scanLogs = [];
  refreshCustomerStatus(customer);

  if (state.lastAction?.customerId === supplierId) {
    state.lastAction = null;
  }

  clearInspectionInputs();
  persistState();
  renderAll();
  setMessage(`卸先「${customer.name}」の検品状態をリセットしました。`, 'ok');
}


// -----------------------------
// Utility
// -----------------------------
function refreshCustomerStatus(customer) {
  const items = Object.values(customer.itemsByBarcode);
  const hasOver = items.some(item => item.checkedQty > item.plannedQty);
  const checkedQty = items.reduce((sum, item) => sum + item.checkedQty, 0);
  const plannedQty = items.reduce((sum, item) => sum + item.plannedQty, 0);

  if (hasOver) {
    customer.status = 'diff';
  } else if (plannedQty > 0 && checkedQty === plannedQty && items.every(item => item.checkedQty === item.plannedQty)) {
    customer.status = 'done';
  } else if (checkedQty > 0) {
    customer.status = 'progress';
  } else {
    customer.status = 'todo';
  }
}

function getCustomerSummary(customer) {
  const items = Object.values(customer.itemsByBarcode);
  return {
    itemCount: items.length,
    plannedQty: items.reduce((sum, item) => sum + item.plannedQty, 0),
    checkedQty: items.reduce((sum, item) => sum + item.checkedQty, 0),
  };
}

function getSelectedCustomer() {
  if (!state.session || !state.selectedCustomerId) return null;
  return state.session.customers[state.selectedCustomerId] || null;
}

function statusLabel(status) {
  switch (status) {
    case 'done': return '完了';
    case 'progress': return '作業中';
    case 'diff': return '差異あり';
    default: return '未着手';
  }
}


function clearInspectionInputs() {
  els.scanInput.value = '';
  els.bulkBarcodeInput.value = '';
  els.bulkQtyInput.value = '1';
}

function setMessage(text, type = 'info') {
  els.messageArea.className = `message ${type}`;
  els.messageArea.textContent = text;
}

function focusCurrentInput() {
  const customer = getSelectedCustomer();
  if (!customer) return;
  if (state.mode === 'continuous') {
    els.scanInput.focus();
  } else {
    els.bulkBarcodeInput.focus();
  }
}

function resetSession() {
  if (!confirm('読み込み済みデータを初期化します。よろしいですか？')) return;
  state.session = null;
  state.selectedCustomerId = null;
  state.lastAction = null;
  clearInspectionInputs();
  localStorage.removeItem(STORAGE_KEY);
  renderAll();
  setMessage('読込データを初期化しました。', 'ok');
}

function formatDateTime(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('ja-JP');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

init();
