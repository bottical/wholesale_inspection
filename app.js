const STORAGE_KEY = 'simple-inspection-poc-state-v1';

const state = {
  session: null,
  selectedCustomerId: null,
  mode: 'continuous',
  lastAction: null,
};

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
  btnLoadSample: document.getElementById('btnLoadSample'),
  btnResetSession: document.getElementById('btnResetSession'),
  btnExportProgress: document.getElementById('btnExportProgress'),
  btnBackToList: document.getElementById('btnBackToList'),
};

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
      onApplyBulk();
    }
  });
  els.bulkQtyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onApplyBulk();
    }
  });
  els.btnUndo.addEventListener('click', undoLastAction);
  els.btnLoadSample.addEventListener('click', loadSampleData);
  els.btnResetSession.addEventListener('click', resetSession);
  els.btnExportProgress.addEventListener('click', exportProgressJson);
  els.btnBackToList.addEventListener('click', () => {
    state.selectedCustomerId = null;
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
  const customerIdx = findHeaderIndex(header, ['卸先', '卸先名', '得意先', '納品先', '届け先']);
  const barcodeIdx = findHeaderIndex(header, ['バーコード', 'jan', 'janコード', 'barcode']);
  const itemNameIdx = findHeaderIndex(header, ['商品名', '品名', '商品']);
  const qtyIdx = findHeaderIndex(header, ['数量', '予定数', '出荷数', '数']);

  if ([customerIdx, barcodeIdx, itemNameIdx, qtyIdx].some(idx => idx < 0)) {
    throw new Error('必要列が見つかりません。想定列名を確認してください。');
  }

  const customers = {};
  rows.slice(1).forEach((row) => {
    const customerName = String(row[customerIdx] || '').trim();
    const barcode = sanitizeBarcode(row[barcodeIdx]);
    const itemName = String(row[itemNameIdx] || '').trim() || '名称未設定';
    const plannedQty = toPositiveInt(row[qtyIdx]);

    if (!customerName || !barcode || plannedQty <= 0) return;

    const customerId = customerName;
    if (!customers[customerId]) {
      customers[customerId] = {
        id: customerId,
        name: customerName,
        itemsByBarcode: {},
        scanLogs: [],
        status: 'todo',
      };
    }

    if (!customers[customerId].itemsByBarcode[barcode]) {
      customers[customerId].itemsByBarcode[barcode] = {
        barcode,
        itemName,
        plannedQty: 0,
        checkedQty: 0,
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
    els.importSummary.textContent = 'まだファイルは読み込まれていません。';
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
    els.customerList.textContent = 'ファイル読込後に一覧が表示されます。';
    return;
  }

  const cards = state.session.customerOrder
    .map(id => state.session.customers[id])
    .filter(customer => !q || customer.name.toLowerCase().includes(q))
    .map(customer => createCustomerCard(customer))
    .join('');

  els.customerList.className = 'customer-list';
  els.customerList.innerHTML = cards || '<div class="panel-body">該当する卸先がありません。</div>';
  els.customerList.querySelectorAll('[data-customer-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.selectedCustomerId = btn.dataset.customerId;
      persistState();
      renderAll();
      focusCurrentInput();
    });
  });
}

function createCustomerCard(customer) {
  const summary = getCustomerSummary(customer);
  const badgeClass = customer.status === 'done'
    ? 'done'
    : customer.status === 'progress'
      ? 'progress'
      : customer.status === 'diff'
        ? 'diff'
        : 'todo';
  return `
    <button class="customer-card ${state.selectedCustomerId === customer.id ? 'active' : ''}" data-customer-id="${escapeHtml(customer.id)}" type="button">
      <div class="customer-top">
        <div class="customer-name">${escapeHtml(customer.name)}</div>
        <span class="badge ${badgeClass}">${statusLabel(customer.status)}</span>
      </div>
      <div class="customer-meta">
        <span>商品数: ${summary.itemCount}</span>
        <span>進捗: ${summary.checkedQty} / ${summary.plannedQty}</span>
        <span>読取履歴: ${customer.scanLogs.length}</span>
      </div>
    </button>
  `;
}

function renderInspection() {
  const customer = getSelectedCustomer();
  if (!customer) {
    els.inspectionTitle.textContent = '卸先を選択してください';
    els.overallProgress.textContent = '-';
    els.overallStatus.textContent = '-';
    els.itemTableWrap.className = 'table-wrap empty';
    els.itemTableWrap.textContent = '卸先を選択すると表示されます。';
    els.logList.className = 'log-list empty';
    els.logList.textContent = 'まだ履歴はありません。';
    return;
  }

  const summary = getCustomerSummary(customer);
  els.inspectionTitle.textContent = customer.name;
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
  const items = Object.values(customer.itemsByBarcode).sort((a, b) => a.barcode.localeCompare(b.barcode));
  if (items.length === 0) {
    els.itemTableWrap.className = 'table-wrap empty';
    els.itemTableWrap.textContent = '商品がありません。';
    return;
  }
  const rows = items.map(item => {
    const isDone = item.checkedQty === item.plannedQty;
    const isOver = item.checkedQty > item.plannedQty;
    const rowClass = isOver ? 'row-over' : isDone ? 'row-complete' : '';
    const pillClass = isOver ? 'over' : isDone ? 'done' : '';
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
    els.logList.textContent = 'まだ履歴はありません。';
    return;
  }
  els.logList.className = 'log-list';
  els.logList.innerHTML = logs.map(log => `
    <div class="log-item">
      <div class="log-top">
        <span>${formatDateTime(log.at)}</span>
        <span>${log.mode === 'bulk' ? '一括' : '連続'}</span>
      </div>
      <div class="log-main">${escapeHtml(log.barcode)} / +${log.qty}</div>
      <div>${escapeHtml(log.itemName || '商品不明')}</div>
    </div>
  `).join('');
}

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
    setMessage('バーコードを入力してください。', 'warn');
    return;
  }
  if (qty <= 0) {
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
    setMessage('先に卸先を選択してください。', 'warn');
    return;
  }
  const item = customer.itemsByBarcode[barcode];
  if (!item) {
    SoundPlayer.playError();
    setMessage(`バーコード ${barcode} はこの卸先に存在しません。`, 'error');
    return;
  }

  const beforeQty = item.checkedQty;
  item.checkedQty += qty;
  const log = {
    id: `log_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    barcode,
    qty,
    mode,
    at: new Date().toISOString(),
    itemName: item.itemName,
  };
  customer.scanLogs.push(log);
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

  const isOver = item.checkedQty > item.plannedQty;
  const becameComplete = isCustomerCompletedJustNow(customer);
  if (isOver) {
    SoundPlayer.playScan();
    setMessage(`数量超過です: ${item.itemName} が ${item.checkedQty} / ${item.plannedQty} になりました。`, 'warn');
  } else {
    SoundPlayer.playScan();
    setMessage(`${item.itemName} を +${qty} しました。`, 'ok');
  }

  if (becameComplete) {
    SoundPlayer.playComplete();
    setMessage(`卸先「${customer.name}」の検品が完了しました。`, 'ok');
  }

  focusCurrentInput();
}

function isCustomerCompletedJustNow(customer) {
  return customer.status === 'done';
}

function undoLastAction() {
  if (!state.lastAction || !state.session) {
    setMessage('取り消せる操作がありません。', 'warn');
    return;
  }
  const { customerId, barcode, qty, logId, beforeQty } = state.lastAction;
  const customer = state.session.customers[customerId];
  if (!customer || !customer.itemsByBarcode[barcode]) {
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
  if (!confirm('現在のセッションを削除します。よろしいですか？')) return;
  state.session = null;
  state.selectedCustomerId = null;
  state.lastAction = null;
  localStorage.removeItem(STORAGE_KEY);
  renderAll();
  setMessage('セッションを削除しました。', 'ok');
}

function exportProgressJson() {
  if (!state.session) {
    setMessage('出力するセッションがありません。', 'warn');
    return;
  }
  const blob = new Blob([JSON.stringify(state.session, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `inspection-progress-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function loadSampleData() {
  const rows = [
    ['卸先名', 'バーコード', '商品名', '数量'],
    ['A商事', '4901000000011', 'サンプル商品A', 3],
    ['A商事', '4901000000028', 'サンプル商品B', 2],
    ['B物産', '4901000000011', 'サンプル商品A', 1],
    ['B物産', '4901000000035', 'サンプル商品C', 4],
    ['C卸', '4901000000042', 'サンプル商品D', 5],
  ];
  state.session = buildSessionFromRows(rows, 'sample.xlsx');
  state.selectedCustomerId = state.session.customerOrder[0] || null;
  state.lastAction = null;
  persistState();
  renderAll();
  setMessage('サンプルデータを読み込みました。', 'ok');
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

const SoundPlayer = (() => {
  let ctx;

  function getCtx() {
    if (!ctx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      ctx = AudioContext ? new AudioContext() : null;
    }
    return ctx;
  }

  function playTone(freq, start, duration, gainValue = 0.05, type = 'sine') {
    const audio = getCtx();
    if (!audio) return;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(gainValue, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain);
    gain.connect(audio.destination);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  function ensureResumed() {
    const audio = getCtx();
    if (audio && audio.state === 'suspended') {
      audio.resume();
    }
    return audio;
  }

  return {
    playScan() {
      const audio = ensureResumed();
      if (!audio) return;
      const now = audio.currentTime;
      playTone(880, now, 0.08, 0.04, 'triangle');
      playTone(1174, now + 0.05, 0.08, 0.03, 'triangle');
    },
    playComplete() {
      const audio = ensureResumed();
      if (!audio) return;
      const now = audio.currentTime;
      playTone(523.25, now, 0.12, 0.05, 'sine');
      playTone(659.25, now + 0.12, 0.12, 0.05, 'sine');
      playTone(783.99, now + 0.24, 0.16, 0.05, 'sine');
      playTone(1046.5, now + 0.40, 0.22, 0.05, 'sine');
    },
    playError() {
      const audio = ensureResumed();
      if (!audio) return;
      const now = audio.currentTime;
      playTone(220, now, 0.14, 0.04, 'sawtooth');
      playTone(180, now + 0.08, 0.16, 0.04, 'sawtooth');
    }
  };
})();

init();
