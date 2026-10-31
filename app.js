/**
 * HỆ THỐNG BÁO CÁO ĐỐI SOÁT TỒN KHO 3D & MULTI-AGENT PDA ZEBRA
 * ---------------------------------------------------------------------------
 * - Giao diện máy quét PDA chuẩn màn hình nhỏ Zebra (Phần quét ở trên: USE, Bin Location, TagID, Qty, OK;
 *   Log tag quét ở ngay bên dưới kèm nút Sửa ✏️ / Xóa 🗑️ tức thì khi quét sai).
 * - Mô hình 3D động hiển thị đầy đủ số liệu trực tiếp trên từng cột, hỗ trợ Dừng xoay, Phóng to/Thu nhỏ,
 *   Góc nhìn chuẩn, Phóng rộng toàn màn hình, và chuyển đổi linh hoạt giữa Biểu đồ Cột / Đường (Line).
 */

const AppState = {
  stockRaw: [],         // Array of { code, wh, date, batch, bin, qty }
  scanRaw: [],          // Array of { stt, tag, loc, user, time, manualQty, isNew }
  stockFileName: 'Stock list.xlsx',
  scanFileName: 'kiêm kho 31.10.2026.xlsx',

  // Active UI Filters
  whFilter: 'ALL',      // 'ALL', '01', '61'
  pfxFilter: 'ALL',     // 'ALL', '3', '5', '7'
  statusFilter: 'ALL',  // 'ALL', 'MISSING', 'COMPLETE', 'DUP', 'LOC_DIFF'
  searchQuery: '',
  activeTab: 'tab-items',

  // PDA Editing State (-1 = New Scan, >=0 = Editing existing row index in scanRaw)
  editingScanIndex: -1,

  // Chart & 3D State
  mainChartMode: 'combo', // 'combo' | 'line' | 'bar'
  autoRotate3D: true,

  // Computed Reconciliation Result
  reconciled: null
};

// Formatters
const fmtNum = (n) => Number(n || 0).toLocaleString('vi-VN');
const fmtCompact = (n) => {
  const v = Number(n || 0);
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return String(v);
};
const fmtPct = (n) => `${Number(n || 0).toFixed(2)}%`;

function normalizeWh(wh) {
  const s = String(wh || '').trim();
  if (s === '1' || s === '01') return '01';
  if (s === '61') return '61';
  return s;
}

function isTargetScope(wh, code) {
  const w = normalizeWh(wh);
  const c = String(code || '').trim();
  return (w === '01' || w === '61') && (c.startsWith('3') || c.startsWith('5') || c.startsWith('7'));
}

/* ==========================================================================
   MULTI-AGENT RECONCILIATION ENGINE
   ========================================================================== */
function runMultiAgentReconciliation() {
  // AGENT 1: Stock Scope Filter (Kho 01 & 61, Item Code 3*, 5*, 7*)
  const filteredStock = [];
  const filteredStockByBatch = new Map();
  const otherStockByBatch = new Map();

  for (const row of AppState.stockRaw) {
    const code = String(row.code || '').trim();
    const wh = normalizeWh(row.wh);
    const batch = String(row.batch || '').trim();
    const bin = String(row.bin || '').trim();
    const qty = Number(row.qty) || 0;
    const item = { code, wh, date: row.date || '', batch, bin, qty };

    if (!batch) continue;
    if (isTargetScope(wh, code)) {
      filteredStock.push(item);
      filteredStockByBatch.set(batch, item);
    } else {
      if (!otherStockByBatch.has(batch)) otherStockByBatch.set(batch, []);
      otherStockByBatch.get(batch).push(item);
    }
  }

  // AGENT 2 & AGENT 3: Scan Indexer, Duplicate Guard & TagID-to-Qty Matcher
  const scanByTag = new Map();
  for (const s of AppState.scanRaw) {
    const tag = String(s.tag || '').trim();
    if (!tag) continue;
    if (!scanByTag.has(tag)) scanByTag.set(tag, []);
    scanByTag.get(tag).push(s);
  }

  // Detect duplicate scanned tags
  const duplicateAlerts = [];
  let totalExtraDuplicateScans = 0;
  let totalPreventedInflatedQty = 0;

  for (const [tag, scans] of scanByTag.entries()) {
    if (scans.length > 1) {
      const st = filteredStockByBatch.get(tag) || (otherStockByBatch.get(tag) ? otherStockByBatch.get(tag)[0] : null);
      const unitQty = (Number(scans[0].manualQty) > 0) ? Number(scans[0].manualQty) : (st ? st.qty : 0);
      const extraCount = scans.length - 1;
      const preventedQty = extraCount * unitQty;
      totalExtraDuplicateScans += extraCount;
      totalPreventedInflatedQty += preventedQty;

      duplicateAlerts.push({
        tag,
        count: scans.length,
        extraCount,
        wh: st ? st.wh : 'Ngoài phạm vi',
        code: st ? st.code : 'Chưa rõ',
        bin: st ? st.bin : '',
        unitQty,
        preventedQty,
        scans
      });
    }
  }

  // Detect unmatched / out-of-scope scan tags
  const unmatchedAlerts = [];
  let unmatchedOtherWhCount = 0;
  let unmatchedUnknownCount = 0;

  for (const [tag, scans] of scanByTag.entries()) {
    if (!filteredStockByBatch.has(tag)) {
      const otherMatches = otherStockByBatch.get(tag);
      if (otherMatches && otherMatches.length > 0) {
        unmatchedOtherWhCount++;
        const first = otherMatches[0];
        unmatchedAlerts.push({
          tag,
          loc: scans[0].loc,
          user: scans[0].user,
          time: scans[0].time,
          count: scans.length,
          type: 'OTHER_SCOPE',
          typeLabel: 'Thuộc Kho / Nhóm Mã Khác',
          info: `Kho ${first.wh} | Mã ${first.code} | BIN: ${first.bin || '-'} | SL: ${fmtNum(first.qty)}`
        });
      } else {
        unmatchedUnknownCount++;
        unmatchedAlerts.push({
          tag,
          loc: scans[0].loc,
          user: scans[0].user,
          time: scans[0].time,
          count: scans.length,
          type: 'NOT_IN_STOCK',
          typeLabel: 'Chưa Có Trên Danh Sách Tồn Kho',
          info: scans[0].manualQty ? `SL nhập PDA: ${fmtNum(scans[0].manualQty)}` : 'Không tìm thấy TagID trong Stock List'
        });
      }
    }
  }

  // Filter scope according to UI active Warehouse & Prefix filter
  const activeStock = filteredStock.filter((item) => {
    if (AppState.whFilter !== 'ALL' && item.wh !== AppState.whFilter) return false;
    if (AppState.pfxFilter !== 'ALL' && !item.code.startsWith(AppState.pfxFilter)) return false;
    return true;
  });

  // Detailed Tag reconciliation & Item aggregation
  const tagDetails = [];
  const itemMap = new Map();

  let totalStockTags = 0;
  let totalStockQty = 0;
  let totalScannedTags = 0;
  let totalScannedQty = 0;
  let totalMissingTags = 0;
  let totalMissingQty = 0;
  let totalLocMismatch = 0;

  for (const st of activeStock) {
    const scans = scanByTag.get(st.batch) || [];
    const isScanned = scans.length > 0;
    const isDup = scans.length > 1;
    // If user manually edited Qty on PDA (>0), respect manualQty; otherwise take Stock Batch Qty
    const scannedQty = isScanned ? ((Number(scans[0].manualQty) > 0) ? Number(scans[0].manualQty) : st.qty) : 0;
    const missingQty = isScanned ? Math.max(0, st.qty - scannedQty) : st.qty;
    const scanLoc = isScanned ? scans[0].loc : '';
    const isLocDiff = isScanned && st.bin && scanLoc && st.bin !== scanLoc;

    totalStockTags++;
    totalStockQty += st.qty;

    if (isScanned) {
      totalScannedTags++;
      totalScannedQty += scannedQty;
      totalMissingQty += missingQty;
      if (isLocDiff) totalLocMismatch++;
    } else {
      totalMissingTags++;
      totalMissingQty += missingQty;
    }

    let statusKey = isScanned ? 'COMPLETE' : 'MISSING';
    let statusLabel = isScanned ? 'Đã kiểm đủ' : 'Chưa kiểm (Thiếu)';
    if (isDup) {
      statusLabel = `Trùng TagID (${scans.length}x)`;
    } else if (isLocDiff) {
      statusLabel = 'Đã kiểm (Lệch BIN)';
    }

    tagDetails.push({
      wh: st.wh,
      code: st.code,
      prefix: st.code.charAt(0) + '*',
      batch: st.batch,
      stockQty: st.qty,
      scannedQty,
      missingQty,
      bin: st.bin,
      scanLoc,
      scanCount: scans.length,
      user: isScanned ? scans[0].user : '-',
      time: isScanned ? scans[0].time : '-',
      isScanned,
      isDup,
      isLocDiff,
      statusKey,
      statusLabel
    });

    // Group by (Warehouse, Item Code)
    const itemKey = `${st.wh}__${st.code}`;
    if (!itemMap.has(itemKey)) {
      itemMap.set(itemKey, {
        wh: st.wh,
        code: st.code,
        prefix: st.code.charAt(0) + '*',
        stockTags: 0,
        scannedTags: 0,
        missingTags: 0,
        stockQty: 0,
        scannedQty: 0,
        missingQty: 0,
        dupTags: 0,
        locDiffTags: 0,
        bins: new Set(),
        scanLocs: new Set()
      });
    }
    const grp = itemMap.get(itemKey);
    grp.stockTags++;
    grp.stockQty += st.qty;
    if (st.bin) grp.bins.add(st.bin);

    if (isScanned) {
      grp.scannedTags++;
      grp.scannedQty += scannedQty;
      grp.missingQty += missingQty;
      for (const sc of scans) {
        if (sc.loc) grp.scanLocs.add(sc.loc);
      }
      if (isDup) grp.dupTags++;
      if (isLocDiff) grp.locDiffTags++;
    } else {
      grp.missingTags++;
      grp.missingQty += missingQty;
    }
  }

  const itemSummaries = Array.from(itemMap.values()).map((g) => {
    const pctQty = g.stockQty > 0 ? (g.scannedQty / g.stockQty) * 100 : 0;
    return {
      ...g,
      pctQty,
      binsStr: Array.from(g.bins).join(', ') || '-',
      scanLocsStr: Array.from(g.scanLocs).join(', ') || '-'
    };
  }).sort((a, b) => b.missingQty - a.missingQty || b.stockQty - a.stockQty);

  // Executive Matrix Breakdown by (WH, Prefix)
  const matrixMap = new Map();
  const combos = [
    ['01', '3*'], ['01', '5*'], ['01', '7*'],
    ['61', '3*'], ['61', '5*'], ['61', '7*']
  ];
  for (const [w, p] of combos) {
    matrixMap.set(`${w}_${p}`, {
      wh: w,
      prefix: p,
      items: new Set(),
      stockTags: 0,
      scannedTags: 0,
      missingTags: 0,
      stockQty: 0,
      scannedQty: 0,
      missingQty: 0
    });
  }

  for (const td of tagDetails) {
    const key = `${td.wh}_${td.prefix}`;
    if (!matrixMap.has(key)) continue;
    const m = matrixMap.get(key);
    m.items.add(td.code);
    m.stockTags++;
    m.stockQty += td.stockQty;
    if (td.isScanned) {
      m.scannedTags++;
      m.scannedQty += td.scannedQty;
      m.missingQty += td.missingQty;
    } else {
      m.missingTags++;
      m.missingQty += td.missingQty;
    }
  }

  // User scan statistics
  const userStatsMap = new Map();
  for (const s of AppState.scanRaw) {
    const rawUser = String(s.user || 'Khác').trim();
    if (!rawUser) continue;
    const normUser = rawUser.charAt(0).toUpperCase() + rawUser.slice(1).toLowerCase();
    userStatsMap.set(normUser, (userStatsMap.get(normUser) || 0) + 1);
  }

  const uniqueItemCodesCount = new Set(activeStock.map((x) => x.code)).size;

  AppState.reconciled = {
    filteredStockCountAll: filteredStock.length,
    filteredStockQtyAll: filteredStock.reduce((acc, x) => acc + x.qty, 0),
    filteredStockByBatch,
    otherStockByBatch,
    scanByTag,
    uniqueScanTagsCount: scanByTag.size,
    totalStockTags,
    totalStockQty,
    uniqueItemCodesCount,
    totalScannedTags,
    totalScannedQty,
    totalMissingTags,
    totalMissingQty,
    totalLocMismatch,
    duplicateAlerts,
    totalExtraDuplicateScans,
    totalPreventedInflatedQty,
    unmatchedAlerts,
    unmatchedOtherWhCount,
    unmatchedUnknownCount,
    itemSummaries,
    tagDetails,
    matrixRows: Array.from(matrixMap.values()).filter((m) => m.stockTags > 0),
    userStats: Array.from(userStatsMap.entries()).sort((a, b) => b[1] - a[1])
  };

  updateDashboardUI();
}

/* ==========================================================================
   UPDATE DASHBOARD UI, KPI CARDS, CHARTS & TABLES
   ========================================================================== */
function updateDashboardUI() {
  const r = AppState.reconciled;
  if (!r) return;

  const hasStock = AppState.stockRaw.length > 0;
  const hasScan = AppState.scanRaw.length > 0;
  document.getElementById('agent1-dot').className = 'agent-dot' + (hasStock ? '' : ' idle');
  document.getElementById('agent2-dot').className = 'agent-dot' + (hasStock && hasScan ? '' : ' idle');
  document.getElementById('agent3-dot').className = 'agent-dot' + (hasScan ? '' : ' idle');
  document.getElementById('agent4-dot').className = 'agent-dot' + (hasStock || hasScan ? '' : ' idle');

  document.getElementById('agent1-status').textContent = hasStock
    ? `Đã lọc ${fmtNum(r.filteredStockCountAll)} Tag từ ${fmtNum(AppState.stockRaw.length)} dòng`
    : 'Đang chờ nạp dữ liệu Tồn kho (0 dòng)';
  document.getElementById('agent2-status').textContent = (hasStock && hasScan)
    ? `Khớp ${fmtNum(r.totalScannedTags)}/${fmtNum(r.totalStockTags)} Tag (${fmtPct(r.totalStockQty ? (r.totalScannedQty / r.totalStockQty) * 100 : 0)} SL)`
    : 'Chờ dữ liệu 2 bảng để đối soát (0)';
  document.getElementById('agent3-status').textContent = hasScan
    ? `Phát hiện ${fmtNum(r.duplicateAlerts.length)} Tag trùng & ${fmtNum(r.totalLocMismatch)} lệch BIN`
    : 'Đang chờ dữ liệu quét PDA (0)';
  document.getElementById('agent4-status').textContent = (hasStock || hasScan)
    ? `Sẵn sàng xuất báo cáo 5 Sheet (${fmtNum(r.itemSummaries.length)} mã)`
    : 'Hệ thống đã đưa về 0';

  // Source Box 1 (Stock)
  document.getElementById('stock-file-label').textContent = hasStock
    ? `Nguồn hiện tại: ${AppState.stockFileName}`
    : 'Đã xóa dữ liệu cũ — Vui lòng nhập file Tồn kho mới';
  const stockBadge = document.getElementById('stock-status-badge');
  stockBadge.textContent = hasStock ? 'Đã nạp dữ liệu' : 'Trống (0)';
  stockBadge.className = 'source-status-badge' + (hasStock ? '' : ' empty');
  document.getElementById('sm-stock-raw').textContent = fmtNum(AppState.stockRaw.length);
  document.getElementById('sm-stock-filtered').textContent = fmtNum(r.filteredStockCountAll);
  document.getElementById('sm-stock-qty').textContent = fmtNum(r.filteredStockQtyAll);

  // Source Box 2 (Scan)
  document.getElementById('scan-file-label').textContent = hasScan
    ? `Nguồn hiện tại: ${AppState.scanFileName}`
    : 'Đã xóa dữ liệu cũ — Vui lòng nhập file Kiểm kê hoặc Quét PDA';
  const scanBadge = document.getElementById('scan-status-badge');
  scanBadge.textContent = hasScan ? 'Đã nạp dữ liệu' : 'Trống (0)';
  scanBadge.className = 'source-status-badge' + (hasScan ? '' : ' empty');
  document.getElementById('sm-scan-raw').textContent = fmtNum(AppState.scanRaw.length);
  document.getElementById('sm-scan-unique').textContent = fmtNum(r.uniqueScanTagsCount);
  document.getElementById('sm-scan-dup').textContent = `${fmtNum(r.duplicateAlerts.length)} Tag (${fmtNum(r.totalExtraDuplicateScans)} lượt dư)`;

  // 6 Dynamic 3D KPI Cards
  const scannedPctQty = r.totalStockQty > 0 ? (r.totalScannedQty / r.totalStockQty) * 100 : 0;
  const missingPctQty = r.totalStockQty > 0 ? (r.totalMissingQty / r.totalStockQty) * 100 : 0;
  const scannedPctTag = r.totalStockTags > 0 ? (r.totalScannedTags / r.totalStockTags) * 100 : 0;
  const missingPctTag = r.totalStockTags > 0 ? (r.totalMissingTags / r.totalStockTags) * 100 : 0;

  document.getElementById('kpi-stock-qty').textContent = fmtNum(r.totalStockQty);
  document.getElementById('kpi-stock-tags').textContent = `${fmtNum(r.totalStockTags)} TagID`;
  document.getElementById('kpi-stock-items').textContent = `${fmtNum(r.uniqueItemCodesCount)} Mã hàng`;
  document.getElementById('bar-stock').style.width = r.totalStockQty > 0 ? '100%' : '0%';

  document.getElementById('kpi-scanned-qty').textContent = fmtNum(r.totalScannedQty);
  document.getElementById('kpi-scanned-tags').textContent = `${fmtNum(r.totalScannedTags)} Tag (${fmtPct(scannedPctTag)})`;
  document.getElementById('kpi-scanned-pct').textContent = fmtPct(scannedPctQty);
  document.getElementById('bar-scanned').style.width = `${Math.min(100, scannedPctQty)}%`;

  document.getElementById('kpi-missing-qty').textContent = fmtNum(r.totalMissingQty);
  document.getElementById('kpi-missing-tags').textContent = `${fmtNum(r.totalMissingTags)} Tag (${fmtPct(missingPctTag)})`;
  document.getElementById('kpi-missing-pct').textContent = fmtPct(missingPctQty);
  document.getElementById('bar-missing').style.width = `${Math.min(100, missingPctQty)}%`;

  document.getElementById('kpi-dup-tags').textContent = fmtNum(r.duplicateAlerts.length);
  document.getElementById('kpi-dup-extra').textContent = `${fmtNum(r.totalExtraDuplicateScans)} lượt quét dư`;
  document.getElementById('kpi-dup-prevented').textContent = `Chặn +${fmtNum(r.totalPreventedInflatedQty)} SL ảo`;
  document.getElementById('bar-dup').style.width = r.duplicateAlerts.length > 0 ? '100%' : '0%';

  const locPct = r.totalScannedTags > 0 ? (r.totalLocMismatch / r.totalScannedTags) * 100 : 0;
  document.getElementById('kpi-loc-diff').textContent = fmtNum(r.totalLocMismatch);
  document.getElementById('kpi-loc-pct').textContent = `${fmtPct(locPct)} Tag đã quét`;
  document.getElementById('bar-loc').style.width = `${Math.min(100, locPct * 4)}%`;

  document.getElementById('kpi-out-tags').textContent = fmtNum(r.unmatchedAlerts.length);
  document.getElementById('kpi-out-other').textContent = `${fmtNum(r.unmatchedOtherWhCount)} kho/mã khác`;
  document.getElementById('kpi-out-unknown').textContent = `${fmtNum(r.unmatchedUnknownCount)} chưa có sổ`;
  document.getElementById('bar-out').style.width = r.unmatchedAlerts.length > 0 ? '65%' : '0%';

  // Update Executive Summary Matrix
  renderExecutiveMatrix(r);

  // Update Tab Counts & Tables
  document.getElementById('count-tab-items').textContent = fmtNum(r.itemSummaries.length);
  document.getElementById('count-tab-details').textContent = fmtNum(r.tagDetails.length);
  document.getElementById('count-tab-duplicates').textContent = fmtNum(r.duplicateAlerts.length);
  document.getElementById('count-tab-unmatched').textContent = fmtNum(r.unmatchedAlerts.length);
  document.getElementById('count-tab-pda-log').textContent = fmtNum(AppState.scanRaw.length);

  renderActiveTables();
  renderPdaModalTable();
  updateCharts(r);
  update3DScene(r);
}

/* ==========================================================================
   RENDER EXECUTIVE MATRIX & DETAILED TABLES
   ========================================================================== */
function renderExecutiveMatrix(r) {
  const tbody = document.getElementById('exec-matrix-tbody');
  if (r.matrixRows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="12" style="text-align:center; padding:24px; color:#94a3b8;">Không có dữ liệu tồn kho để đối soát (Hệ thống đang ở trạng thái 0).</td></tr>`;
    return;
  }

  let html = '';
  for (const row of r.matrixRows) {
    const tagPct = row.stockTags > 0 ? (row.scannedTags / row.stockTags) * 100 : 0;
    const qtyPct = row.stockQty > 0 ? (row.scannedQty / row.stockQty) * 100 : 0;
    const badgeClass = qtyPct >= 95 ? 'status-ok' : (qtyPct >= 85 ? 'status-dup' : 'status-miss');
    const badgeText = qtyPct >= 95 ? 'Rất tốt (≥95%)' : (qtyPct >= 85 ? 'Khá (Cần rà soát)' : 'Cần kiểm bổ sung');

    html += `
      <tr>
        <td><strong>Kho ${row.wh}</strong></td>
        <td><span class="badge-scope">Nhóm ${row.prefix}</span></td>
        <td class="num-col">${fmtNum(row.items.size)}</td>
        <td class="num-col">${fmtNum(row.stockTags)}</td>
        <td class="num-col" style="color:#34d399;">${fmtNum(row.scannedTags)}</td>
        <td class="num-col" style="color:#fb7185;">${fmtNum(row.missingTags)}</td>
        <td class="num-col">${fmtPct(tagPct)}</td>
        <td class="num-col"><strong>${fmtNum(row.stockQty)}</strong></td>
        <td class="num-col" style="color:#34d399;"><strong>${fmtNum(row.scannedQty)}</strong></td>
        <td class="num-col" style="color:#fb7185;"><strong>${fmtNum(row.missingQty)}</strong></td>
        <td class="num-col"><strong>${fmtPct(qtyPct)}</strong></td>
        <td><span class="status-pill ${badgeClass}">${badgeText}</span></td>
      </tr>
    `;
  }

  const totalTagPct = r.totalStockTags > 0 ? (r.totalScannedTags / r.totalStockTags) * 100 : 0;
  const totalQtyPct = r.totalStockQty > 0 ? (r.totalScannedQty / r.totalStockQty) * 100 : 0;
  html += `
    <tr style="background: rgba(56, 189, 248, 0.14); font-weight: 800;">
      <td colspan="2">TỔNG CỘNG TOÀN PHẠM VI</td>
      <td class="num-col">${fmtNum(r.uniqueItemCodesCount)}</td>
      <td class="num-col">${fmtNum(r.totalStockTags)}</td>
      <td class="num-col" style="color:#34d399;">${fmtNum(r.totalScannedTags)}</td>
      <td class="num-col" style="color:#fb7185;">${fmtNum(r.totalMissingTags)}</td>
      <td class="num-col">${fmtPct(totalTagPct)}</td>
      <td class="num-col">${fmtNum(r.totalStockQty)}</td>
      <td class="num-col" style="color:#34d399;">${fmtNum(r.totalScannedQty)}</td>
      <td class="num-col" style="color:#fb7185;">${fmtNum(r.totalMissingQty)}</td>
      <td class="num-col">${fmtPct(totalQtyPct)}</td>
      <td><span class="status-pill status-ok">Đã khử trùng TagID</span></td>
    </tr>
  `;
  tbody.innerHTML = html;
}

function renderActiveTables() {
  const r = AppState.reconciled;
  if (!r) return;
  const q = AppState.searchQuery.toLowerCase().trim();
  const sf = AppState.statusFilter;

  // 1. Render Tab Items
  const filteredItems = r.itemSummaries.filter((item) => {
    if (sf === 'MISSING' && item.missingTags === 0) return false;
    if (sf === 'COMPLETE' && item.missingTags > 0) return false;
    if (sf === 'DUP' && item.dupTags === 0) return false;
    if (sf === 'LOC_DIFF' && item.locDiffTags === 0) return false;
    if (q) {
      const hay = `${item.wh} ${item.code} ${item.binsStr} ${item.scanLocsStr}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const tbodyItems = document.getElementById('tbody-items');
  if (filteredItems.length === 0) {
    tbodyItems.innerHTML = `<tr><td colspan="14" style="text-align:center; padding:24px; color:#94a3b8;">Không có mã hàng nào khớp bộ lọc.</td></tr>`;
  } else {
    tbodyItems.innerHTML = filteredItems.slice(0, 500).map((it, i) => {
      let stPill = `<span class="status-pill status-ok">Đủ 100%</span>`;
      if (it.missingTags > 0) {
        stPill = `<span class="status-pill status-miss">Thiếu ${fmtNum(it.missingTags)} Tag</span>`;
      } else if (it.dupTags > 0) {
        stPill = `<span class="status-pill status-dup">Có Tag trùng</span>`;
      }
      return `
        <tr>
          <td>${i + 1}</td>
          <td><strong>Kho ${it.wh}</strong></td>
          <td style="font-family:'JetBrains Mono',monospace; font-weight:700; color:#7dd3fc;">${it.code}</td>
          <td>${it.prefix}</td>
          <td class="num-col">${fmtNum(it.stockTags)}</td>
          <td class="num-col" style="color:#34d399;">${fmtNum(it.scannedTags)}</td>
          <td class="num-col" style="color:#fb7185;">${fmtNum(it.missingTags)}</td>
          <td class="num-col">${fmtNum(it.stockQty)}</td>
          <td class="num-col" style="color:#34d399;"><strong>${fmtNum(it.scannedQty)}</strong></td>
          <td class="num-col" style="color:#fb7185;"><strong>${fmtNum(it.missingQty)}</strong></td>
          <td class="num-col">${fmtPct(it.pctQty)}</td>
          <td style="max-width:190px; overflow:hidden; text-overflow:ellipsis;" title="${it.binsStr}">${it.binsStr}</td>
          <td style="max-width:190px; overflow:hidden; text-overflow:ellipsis;" title="${it.scanLocsStr}">${it.scanLocsStr}</td>
          <td>${stPill}</td>
        </tr>
      `;
    }).join('');
  }

  // 2. Render Tab Details (By TagID / Batch)
  const filteredDetails = r.tagDetails.filter((td) => {
    if (sf === 'MISSING' && td.isScanned) return false;
    if (sf === 'COMPLETE' && !td.isScanned) return false;
    if (sf === 'DUP' && !td.isDup) return false;
    if (sf === 'LOC_DIFF' && !td.isLocDiff) return false;
    if (q) {
      const hay = `${td.wh} ${td.code} ${td.batch} ${td.bin} ${td.scanLoc} ${td.user}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const tbodyDetails = document.getElementById('tbody-details');
  if (filteredDetails.length === 0) {
    tbodyDetails.innerHTML = `<tr><td colspan="13" style="text-align:center; padding:24px; color:#94a3b8;">Không có TagID nào khớp bộ lọc.</td></tr>`;
  } else {
    tbodyDetails.innerHTML = filteredDetails.slice(0, 600).map((td, i) => {
      let cls = td.isScanned ? 'status-ok' : 'status-miss';
      if (td.isDup) cls = 'status-dup';
      else if (td.isLocDiff) cls = 'status-warn';
      return `
        <tr>
          <td>${i + 1}</td>
          <td>Kho ${td.wh}</td>
          <td style="font-family:'JetBrains Mono',monospace; font-weight:700;">${td.code}</td>
          <td style="font-family:'JetBrains Mono',monospace; color:#7dd3fc;">${td.batch}</td>
          <td class="num-col">${fmtNum(td.stockQty)}</td>
          <td class="num-col" style="color:#34d399;">${fmtNum(td.scannedQty)}</td>
          <td class="num-col" style="color:#fb7185;">${fmtNum(td.missingQty)}</td>
          <td>${td.bin || '-'}</td>
          <td>${td.scanLoc || '-'}</td>
          <td class="num-col">${td.scanCount}</td>
          <td>${td.user}</td>
          <td>${td.time}</td>
          <td><span class="status-pill ${cls}">${td.statusLabel}</span></td>
        </tr>
      `;
    }).join('');
  }

  // 3. Render Tab Duplicates
  const tbodyDup = document.getElementById('tbody-duplicates');
  const dupsFiltered = r.duplicateAlerts.filter((d) => {
    if (!q) return true;
    return `${d.tag} ${d.code} ${d.wh} ${d.bin}`.toLowerCase().includes(q);
  });
  if (dupsFiltered.length === 0) {
    tbodyDup.innerHTML = `<tr><td colspan="10" style="text-align:center; padding:24px; color:#94a3b8;">Không có cảnh báo trùng TagID.</td></tr>`;
  } else {
    tbodyDup.innerHTML = dupsFiltered.map((d, i) => {
      const scansDesc = d.scans.map((s) => `[STT ${s.stt}: User ${s.user} @ Vị trí ${s.loc || '-'} (${s.time})]`).join(' ⚡ ');
      return `
        <tr>
          <td>${i + 1}</td>
          <td style="font-family:'JetBrains Mono',monospace; font-weight:700; color:#fbbf24;">${d.tag}</td>
          <td class="num-col"><strong>${d.count} lần</strong></td>
          <td>Kho ${d.wh}</td>
          <td style="font-family:'JetBrains Mono',monospace;">${d.code}</td>
          <td class="num-col">${fmtNum(d.unitQty)}</td>
          <td class="num-col" style="color:#fbbf24;"><strong>+${fmtNum(d.preventedQty)}</strong></td>
          <td>${d.bin || '-'}</td>
          <td style="white-space:normal; min-width:360px; font-size:0.77rem;">${scansDesc}</td>
          <td><span class="status-pill status-dup">Đã chặn cộng trùng</span></td>
        </tr>
      `;
    }).join('');
  }

  // 4. Render Tab Unmatched
  const tbodyUnmatched = document.getElementById('tbody-unmatched');
  const unmFiltered = r.unmatchedAlerts.filter((u) => {
    if (!q) return true;
    return `${u.tag} ${u.loc} ${u.user} ${u.info}`.toLowerCase().includes(q);
  });
  if (unmFiltered.length === 0) {
    tbodyUnmatched.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:24px; color:#94a3b8;">Không có TagID ngoài phạm vi.</td></tr>`;
  } else {
    tbodyUnmatched.innerHTML = unmFiltered.map((u, i) => {
      const pill = u.type === 'OTHER_SCOPE'
        ? `<span class="status-pill status-warn">${u.typeLabel}</span>`
        : `<span class="status-pill status-miss">${u.typeLabel}</span>`;
      return `
        <tr>
          <td>${i + 1}</td>
          <td style="font-family:'JetBrains Mono',monospace; font-weight:700; color:#f43f5e;">${u.tag}</td>
          <td>${u.loc || '-'}</td>
          <td>${u.user || '-'}</td>
          <td>${u.time || '-'}</td>
          <td>${pill}</td>
          <td>${u.info}</td>
        </tr>
      `;
    }).join('');
  }

  // 5. Render Tab PDA Log (Top Row = Newest Scan + Edit/Delete buttons)
  const tbodyPdaLog = document.getElementById('tbody-pda-log');
  if (AppState.scanRaw.length === 0) {
    tbodyPdaLog.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:24px; color:#94a3b8;">Bảng dữ liệu quét PDA đang trống (0 dòng).</td></tr>`;
  } else {
    const rowsHtml = [];
    for (let i = 0; i < AppState.scanRaw.length && rowsHtml.length < 500; i++) {
      const s = AppState.scanRaw[i];
      if (q && !`${s.tag} ${s.loc} ${s.user} ${s.time}`.toLowerCase().includes(q)) continue;
      const st = r.filteredStockByBatch.get(s.tag);
      const scansForTag = r.scanByTag.get(s.tag) || [];
      const qty = (Number(s.manualQty) > 0) ? Number(s.manualQty) : (st ? st.qty : 0);
      let badge = `<span class="status-pill status-ok">Khớp</span>`;
      if (!st) badge = `<span class="status-pill status-warn">Ngoài Kho 01/61</span>`;
      else if (scansForTag.length > 1) badge = `<span class="status-pill status-dup">Trùng (${scansForTag.length}x)</span>`;

      rowsHtml.push(`
        <tr class="${s.isNew ? 'new-scan-highlight' : ''}">
          <td><strong>#${i + 1}</strong> ${s.isNew ? '🆕' : ''}</td>
          <td>
            <button class="row-action-btn" onclick="openPdaAndEditRow(${i})" title="Sửa dòng này">✏️ Sửa</button>
            <button class="row-action-btn del" onclick="deletePdaRow(${i})" title="Xóa dòng này">🗑️ Xóa</button>
          </td>
          <td style="font-family:'JetBrains Mono',monospace; font-weight:700; color:#7dd3fc;">${s.tag}</td>
          <td>${s.loc || '-'}</td>
          <td><strong>${s.user || '-'}</strong></td>
          <td class="num-col"><strong>${fmtNum(qty)}</strong></td>
          <td style="font-family:'JetBrains Mono',monospace;">${st ? `${st.code} (Kho ${st.wh})` : '-'}</td>
          <td>${s.time || '-'}</td>
          <td>${badge}</td>
        </tr>
      `);
    }
    tbodyPdaLog.innerHTML = rowsHtml.join('');
  }

  document.getElementById('table-showing-info').textContent =
    `Đang lọc: ${fmtNum(filteredItems.length)} Mã hàng | ${fmtNum(filteredDetails.length)} TagID`;
}

/* ==========================================================================
   ZEBRA PDA COMPACT SCANNER MODAL (USE, Bin Location, TagID, Qty, OK + EDIT/DELETE)
   ========================================================================== */
function openPdaModal() {
  document.getElementById('pda-modal-overlay').classList.add('open');
  renderPdaModalTable();
  setTimeout(() => {
    const locInput = document.getElementById('pda-input-loc');
    if (locInput) locInput.focus();
  }, 80);
}

function closePdaModal() {
  cancelPdaEditMode();
  document.getElementById('pda-modal-overlay').classList.remove('open');
}

function openPdaAndEditRow(idx) {
  openPdaModal();
  editPdaRow(idx);
}

function handlePdaKeydown(event, nextFieldId) {
  if (event.key === 'Enter') {
    event.preventDefault();
    if (nextFieldId === 'SUBMIT') {
      submitPdaScan();
    } else {
      const nextEl = document.getElementById(nextFieldId);
      if (nextEl) {
        nextEl.focus();
        if (nextEl.select) nextEl.select();
      }
    }
  }
}

function handlePdaTagLookup(tagVal) {
  const tag = String(tagVal || '').trim();
  const box = document.getElementById('pda-live-lookup');
  const qtyInput = document.getElementById('pda-input-qty');
  const r = AppState.reconciled;
  if (!tag || !r) {
    box.innerHTML = 'Sẵn sàng quét TagID...';
    box.style.borderColor = 'rgba(56, 189, 248, 0.25)';
    return;
  }

  const existingScans = r.scanByTag.get(tag) || [];
  const st = r.filteredStockByBatch.get(tag);
  const otherSt = r.otherStockByBatch.get(tag);

  if (st) {
    if (AppState.editingScanIndex < 0) {
      qtyInput.value = st.qty;
    }
    if (existingScans.length > 0 && AppState.editingScanIndex < 0) {
      box.style.borderColor = '#f59e0b';
      box.innerHTML = `⚠️ TRÙNG TAG (${existingScans.length}x) | Mã ${st.code} | SL: ${fmtNum(st.qty)}`;
    } else {
      box.style.borderColor = '#10b981';
      box.innerHTML = `✅ Mã: <strong>${st.code}</strong> (Kho ${st.wh}) | BIN: ${st.bin || '-'} | SL: <strong style="color:#34d399;">${fmtNum(st.qty)}</strong>`;
    }
  } else if (otherSt && otherSt.length > 0) {
    const o = otherSt[0];
    if (AppState.editingScanIndex < 0) qtyInput.value = o.qty;
    box.style.borderColor = '#a855f7';
    box.innerHTML = `ℹ️ Kho ${o.wh} | Mã ${o.code} | SL: ${fmtNum(o.qty)}`;
  } else {
    box.style.borderColor = '#f43f5e';
    box.innerHTML = `❓ Tag chưa có trên sổ tồn — Nhập Qty thủ công`;
  }
}

function submitPdaScan() {
  const userEl = document.getElementById('pda-input-user');
  const locEl = document.getElementById('pda-input-loc');
  const tagEl = document.getElementById('pda-input-tag');
  const qtyEl = document.getElementById('pda-input-qty');

  const user = String(userEl.value || '').trim() || 'USER';
  const loc = String(locEl.value || '').trim() || '-';
  const tag = String(tagEl.value || '').trim();
  const manualQty = Number(qtyEl.value) || 0;

  if (!tag) {
    tagEl.focus();
    return;
  }

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const timeStr = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  if (AppState.editingScanIndex >= 0 && AppState.editingScanIndex < AppState.scanRaw.length) {
    // Update existing row in-place
    const row = AppState.scanRaw[AppState.editingScanIndex];
    row.user = user;
    row.loc = loc;
    row.tag = tag;
    row.manualQty = manualQty;
    row.time = timeStr;
    row.isNew = true;

    cancelPdaEditMode();
    runMultiAgentReconciliation();
    document.getElementById('pda-live-lookup').innerHTML = `✅ Đã cập nhật dòng sửa Tag <strong>${tag}</strong>!`;
    tagEl.focus();
    return;
  }

  // Insert NEW scan at Top Row (Row 1 / index 0)
  const newScanRecord = {
    stt: `PDA-${AppState.scanRaw.length + 1}`,
    tag,
    loc,
    user,
    time: timeStr,
    manualQty,
    isNew: true
  };

  AppState.scanRaw.unshift(newScanRecord);
  AppState.scanFileName = `Quét PDA (${AppState.scanRaw.length} dòng)`;

  runMultiAgentReconciliation();

  tagEl.value = '';
  qtyEl.value = '';
  document.getElementById('pda-live-lookup').innerHTML = `✅ Đã ghi Dòng 1: <strong>${tag}</strong> (${loc})`;
  tagEl.focus();
}

function editPdaRow(idx) {
  if (idx < 0 || idx >= AppState.scanRaw.length) return;
  const row = AppState.scanRaw[idx];
  const r = AppState.reconciled;
  const st = r ? r.filteredStockByBatch.get(row.tag) : null;
  const qty = (Number(row.manualQty) > 0) ? Number(row.manualQty) : (st ? st.qty : 0);

  AppState.editingScanIndex = idx;
  document.getElementById('pda-input-user').value = row.user || '';
  document.getElementById('pda-input-loc').value = row.loc || '';
  document.getElementById('pda-input-tag').value = row.tag || '';
  document.getElementById('pda-input-qty').value = qty || '';

  const okBtn = document.getElementById('pda-ok-btn');
  okBtn.textContent = `LƯU DÒNG #${idx + 1}`;
  okBtn.classList.add('editing-mode');

  const box = document.getElementById('pda-live-lookup');
  box.style.borderColor = '#f59e0b';
  box.innerHTML = `✏️ Đang sửa Dòng #${idx + 1} (${row.tag}) — Bấm LƯU sau khi sửa`;
  document.getElementById('pda-input-tag').focus();
}

function cancelPdaEditMode() {
  AppState.editingScanIndex = -1;
  const okBtn = document.getElementById('pda-ok-btn');
  if (okBtn) {
    okBtn.textContent = 'OK';
    okBtn.classList.remove('editing-mode');
  }
  document.getElementById('pda-input-tag').value = '';
  document.getElementById('pda-input-qty').value = '';
}

function deletePdaRow(idx) {
  if (idx < 0 || idx >= AppState.scanRaw.length) return;
  const removed = AppState.scanRaw.splice(idx, 1)[0];
  if (AppState.editingScanIndex === idx) {
    cancelPdaEditMode();
  } else if (AppState.editingScanIndex > idx) {
    AppState.editingScanIndex--;
  }
  runMultiAgentReconciliation();
  const box = document.getElementById('pda-live-lookup');
  if (box && removed) {
    box.style.borderColor = '#f43f5e';
    box.innerHTML = `🗑️ Đã xóa dòng Tag <strong>${removed.tag}</strong>`;
  }
}

function editLatestPdaScan() {
  if (AppState.scanRaw.length === 0) return;
  editPdaRow(0);
}

function deleteLatestPdaScan() {
  if (AppState.scanRaw.length === 0) return;
  deletePdaRow(0);
}

function fillSampleUnscannedTag() {
  const r = AppState.reconciled;
  if (!r) return;
  cancelPdaEditMode();
  const missingItem = r.tagDetails.find((t) => !t.isScanned);
  if (!missingItem) {
    alert('Tất cả TagID trong phạm vi lọc hiện tại đều đã được quét đủ 100%!');
    return;
  }
  document.getElementById('pda-input-loc').value = missingItem.bin || '010101';
  document.getElementById('pda-input-tag').value = missingItem.batch;
  handlePdaTagLookup(missingItem.batch);
  document.getElementById('pda-input-qty').focus();
}

function renderPdaModalTable() {
  const tbody = document.getElementById('pda-modal-tbody');
  const countEl = document.getElementById('zebra-log-count');
  if (countEl) countEl.textContent = fmtNum(AppState.scanRaw.length);
  if (!tbody || !AppState.reconciled) return;
  const r = AppState.reconciled;

  if (AppState.scanRaw.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:16px; color:#94a3b8;">Trống (0 dòng)</td></tr>`;
    return;
  }

  tbody.innerHTML = AppState.scanRaw.slice(0, 120).map((s, idx) => {
    const st = r.filteredStockByBatch.get(s.tag);
    const scansForTag = r.scanByTag.get(s.tag) || [];
    const qty = (Number(s.manualQty) > 0) ? Number(s.manualQty) : (st ? st.qty : 0);
    const isDup = scansForTag.length > 1;
    const tagColor = !st ? '#f43f5e' : (isDup ? '#fbbf24' : '#34d399');

    return `
      <tr class="${s.isNew ? 'new-scan-highlight' : ''}">
        <td><strong>${idx + 1}</strong></td>
        <td>
          <button class="row-action-btn" onclick="editPdaRow(${idx})" title="Sửa dòng này">✏️</button>
          <button class="row-action-btn del" onclick="deletePdaRow(${idx})" title="Xóa dòng này">🗑️</button>
        </td>
        <td style="font-family:'JetBrains Mono',monospace; font-weight:700; color:${tagColor};">${s.tag}</td>
        <td>${s.loc || '-'}</td>
        <td class="num-col"><strong>${fmtNum(qty)}</strong></td>
        <td>${s.user || '-'}</td>
      </tr>
    `;
  }).join('');
}

/* ==========================================================================
   UNIVERSAL FILE IMPORTER & CLEAR DATA CONTROLS (XÓA DỮ LIỆU CŨ VỀ 0)
   ========================================================================== */
function clearStockData() {
  AppState.stockRaw = [];
  AppState.stockFileName = 'Đã xóa (0 dòng)';
  document.getElementById('input-file-stock').value = '';
  runMultiAgentReconciliation();
}

function clearScanData() {
  AppState.scanRaw = [];
  AppState.scanFileName = 'Đã xóa (0 dòng)';
  cancelPdaEditMode();
  document.getElementById('input-file-scan').value = '';
  runMultiAgentReconciliation();
}

function clearAllSources() {
  AppState.stockRaw = [];
  AppState.scanRaw = [];
  AppState.stockFileName = 'Đã xóa (0 dòng)';
  AppState.scanFileName = 'Đã xóa (0 dòng)';
  cancelPdaEditMode();
  document.getElementById('input-file-stock').value = '';
  document.getElementById('input-file-scan').value = '';
  runMultiAgentReconciliation();
}

function restoreDefaultData() {
  cancelPdaEditMode();
  loadInitialBundle();
  runMultiAgentReconciliation();
}

function parseUniversalFile(file, callback) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.json')) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        callback(Array.isArray(data) ? data : (data.rows || data.data || []));
      } catch (err) {
        alert('Lỗi đọc file JSON: ' + err.message);
      }
    };
    reader.readAsText(file, 'utf-8');
  } else {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const firstSheet = workbook.SheetNames[0];
        const rows = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet], { defval: '' });
        callback(rows);
      } catch (err) {
        alert('Lỗi đọc file: ' + err.message);
      }
    };
    reader.readAsArrayBuffer(file);
  }
}

function pickCol(rowObj, candidates, fallbackIdx) {
  const keys = Object.keys(rowObj);
  for (const cand of candidates) {
    const found = keys.find((k) => k.trim().toLowerCase() === cand.toLowerCase() || k.trim().toLowerCase().includes(cand.toLowerCase()));
    if (found !== undefined) return rowObj[found];
  }
  if (fallbackIdx !== undefined && keys[fallbackIdx] !== undefined) {
    return rowObj[keys[fallbackIdx]];
  }
  return '';
}

function handleStockFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  parseUniversalFile(file, (rows) => {
    const parsed = [];
    for (const r of rows) {
      if (Array.isArray(r)) {
        parsed.push({
          code: String(r[0] || '').trim(),
          wh: String(r[1] || '').trim(),
          date: String(r[2] || '').trim(),
          batch: String(r[3] || '').trim(),
          bin: String(r[4] || '').trim(),
          qty: Number(String(r[5] || '0').replace(/,/g, '')) || 0
        });
      } else {
        const code = String(pickCol(r, ['Stock Code', 'Item Code', 'Mã hàng', 'Ma hang', 'Item', 'Code'], 0)).trim();
        const wh = String(pickCol(r, ['Wearhouse', 'Warehouse', 'Kho', 'WH'], 1)).trim();
        const date = String(pickCol(r, ['CREATEDATE', 'Date', 'Ngày'], 2)).trim();
        const batch = String(pickCol(r, ['BATCH', 'Tag ID', 'TagID', 'Lô', 'Batch'], 3)).trim();
        const bin = String(pickCol(r, ['BIN', 'Vị trí', 'Location', 'Bin'], 4)).trim();
        const rawQty = String(pickCol(r, ['Qty', 'Quantity', 'Số lượng', 'So luong', 'SL'], 5)).replace(/,/g, '');
        const qty = Number(rawQty) || 0;
        if (code || batch) {
          parsed.push({ code, wh, date, batch, bin, qty });
        }
      }
    }
    AppState.stockRaw = parsed;
    AppState.stockFileName = file.name;
    runMultiAgentReconciliation();
  });
}

function handleScanFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  parseUniversalFile(file, (rows) => {
    const parsed = [];
    rows.forEach((r, idx) => {
      if (Array.isArray(r)) {
        parsed.push({
          stt: String(r[0] || idx + 1).trim(),
          tag: String(r[1] || '').trim(),
          loc: String(r[2] || '').trim(),
          user: String(r[3] || '').trim(),
          time: String(r[4] || '').trim(),
          manualQty: Number(r[5] || 0) || 0
        });
      } else {
        const stt = String(pickCol(r, ['STT', 'No', 'ID'], 0) || idx + 1).trim();
        const tag = String(pickCol(r, ['Tag ID', 'TagID', 'BATCH', 'Batch', 'Mã vạch', 'Barcode'], 1)).trim();
        const loc = String(pickCol(r, ['Vị trí', 'Vi tri', 'BIN', 'Location'], 2)).trim();
        const user = String(pickCol(r, ['User quét', 'User', 'USE', 'Người quét', 'Nhân viên'], 3)).trim();
        const time = String(pickCol(r, ['Thời gian quét', 'Thời gian', 'Time', 'Timestamp'], 4)).trim();
        const manualQty = Number(String(pickCol(r, ['Qty', 'Số lượng', 'SL'], 5) || '0').replace(/,/g, '')) || 0;
        if (tag) {
          parsed.push({ stt, tag, loc, user, time, manualQty });
        }
      }
    });
    AppState.scanRaw = parsed;
    AppState.scanFileName = file.name;
    runMultiAgentReconciliation();
  });
}

/* ==========================================================================
   CHARTS (COMBO BAR + LINE / LINE ONLY / BAR ONLY WITH DIRECT VALUE LABELS)
   ========================================================================== */
let chartPrefixInstance = null;
let chartUsersInstance = null;

function setMainChartMode(mode) {
  AppState.mainChartMode = mode;
  document.getElementById('btn-chart-combo').classList.toggle('active', mode === 'combo');
  document.getElementById('btn-chart-line').classList.toggle('active', mode === 'line');
  document.getElementById('btn-chart-bar').classList.toggle('active', mode === 'bar');
  if (AppState.reconciled) updateCharts(AppState.reconciled);
}

// Custom plugin to draw values directly above bars/points in Chart.js
const directValueLabelPlugin = {
  id: 'directValueLabelPlugin',
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    ctx.save();
    ctx.font = 'bold 10px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';

    chart.data.datasets.forEach((dataset, dsIndex) => {
      const meta = chart.getDatasetMeta(dsIndex);
      if (meta.hidden) return;
      meta.data.forEach((element, index) => {
        const val = dataset.data[index];
        if (!val || val <= 0) return;
        let text = '';
        if (dataset.yAxisID === 'yPct') {
          text = `${Number(val).toFixed(1)}%`;
          ctx.fillStyle = '#38bdf8';
        } else {
          text = fmtCompact(val);
          ctx.fillStyle = dsIndex === 0 ? '#34d399' : '#fb7185';
        }
        ctx.fillText(text, element.x, element.y - 4);
      });
    });
    ctx.restore();
  }
};

function updateCharts(r) {
  const ctxPrefix = document.getElementById('chart-prefix').getContext('2d');
  const labels = r.matrixRows.map((m) => `Kho ${m.wh}-${m.prefix}`);
  const scannedData = r.matrixRows.map((m) => m.scannedQty);
  const missingData = r.matrixRows.map((m) => m.missingQty);
  const pctData = r.matrixRows.map((m) => (m.stockQty > 0 ? Number(((m.scannedQty / m.stockQty) * 100).toFixed(2)) : 0));

  const mode = AppState.mainChartMode;
  const datasets = [];

  if (mode === 'combo' || mode === 'bar') {
    datasets.push(
      {
        type: 'bar',
        label: 'SL Kiểm Được',
        data: scannedData.length ? scannedData : [0],
        backgroundColor: 'rgba(16, 185, 129, 0.82)',
        borderColor: '#10b981',
        borderWidth: 1,
        borderRadius: 6,
        yAxisID: 'y'
      },
      {
        type: 'bar',
        label: 'SL Thiếu',
        data: missingData.length ? missingData : [0],
        backgroundColor: 'rgba(244, 63, 94, 0.85)',
        borderColor: '#f43f5e',
        borderWidth: 1,
        borderRadius: 6,
        yAxisID: 'y'
      }
    );
  }

  if (mode === 'line') {
    datasets.push(
      {
        type: 'line',
        label: 'SL Kiểm Được (Đường)',
        data: scannedData.length ? scannedData : [0],
        borderColor: '#10b981',
        backgroundColor: 'rgba(16, 185, 129, 0.2)',
        fill: true,
        tension: 0.32,
        pointRadius: 5,
        pointBackgroundColor: '#10b981',
        yAxisID: 'y'
      },
      {
        type: 'line',
        label: 'SL Thiếu (Đường)',
        data: missingData.length ? missingData : [0],
        borderColor: '#f43f5e',
        backgroundColor: 'rgba(244, 63, 94, 0.2)',
        fill: true,
        tension: 0.32,
        pointRadius: 5,
        pointBackgroundColor: '#f43f5e',
        yAxisID: 'y'
      }
    );
  }

  if (mode === 'combo' || mode === 'line') {
    datasets.push({
      type: 'line',
      label: '% Đạt SL',
      data: pctData.length ? pctData : [0],
      borderColor: '#38bdf8',
      backgroundColor: '#38bdf8',
      borderWidth: 2.5,
      tension: 0.3,
      pointRadius: 5,
      yAxisID: 'yPct'
    });
  }

  if (chartPrefixInstance) chartPrefixInstance.destroy();
  chartPrefixInstance = new Chart(ctxPrefix, {
    data: {
      labels: labels.length ? labels : ['Trống (0)'],
      datasets
    },
    plugins: [directValueLabelPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 20 } },
      plugins: {
        legend: { labels: { color: '#cbd5e1', font: { size: 11 } } }
      },
      scales: {
        x: { ticks: { color: '#e2e8f0', font: { weight: 'bold' } }, grid: { color: 'rgba(148,163,184,0.08)' } },
        y: {
          position: 'left',
          ticks: { color: '#94a3b8', callback: (v) => fmtCompact(v) },
          grid: { color: 'rgba(148,163,184,0.08)' }
        },
        yPct: {
          position: 'right',
          min: 0,
          max: 115,
          display: mode !== 'bar',
          ticks: { color: '#38bdf8', callback: (v) => `${v}%` },
          grid: { drawOnChartArea: false }
        }
      }
    }
  });

  const ctxUsers = document.getElementById('chart-users').getContext('2d');
  const uLabels = r.userStats.map((u) => `${u[0]} (${fmtNum(u[1])})`);
  const uCounts = r.userStats.map((u) => u[1]);

  if (chartUsersInstance) chartUsersInstance.destroy();
  chartUsersInstance = new Chart(ctxUsers, {
    type: 'doughnut',
    data: {
      labels: uLabels.length ? uLabels : ['Chưa có lượt quét (0)'],
      datasets: [{
        data: uCounts.length ? uCounts : [1],
        backgroundColor: uLabels.length
          ? ['#38bdf8', '#10b981', '#818cf8', '#f59e0b', '#f43f5e', '#a855f7', '#14b8a6']
          : ['rgba(148, 163, 184, 0.2)'],
        borderColor: '#0f172a',
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: '#cbd5e1', font: { size: 11 } } }
      }
    }
  });
}

/* ==========================================================================
   3D WEBGL SCENE WITH DIRECT COLUMN VALUE SPRITES, PAUSE, ZOOM & FULLSCREEN
   ========================================================================== */
let threeScene, threeCamera, threeRenderer, threeBarsGroup;
let isDragging3D = false, prevMouseX = 0, prevMouseY = 0;
let targetRotY = 0.0, targetRotX = 0.18;

// Helper to create crisp 3D Billboard Sprite with multi-line text right on/above 3D pillars
function create3DTextSprite(lines, borderColor = '#38bdf8', scaleWidth = 2.1) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 220;
  const ctx = canvas.getContext('2d');

  // Rounded dark glass box
  ctx.fillStyle = 'rgba(7, 11, 20, 0.88)';
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.roundRect(8, 8, 496, 204, 24);
  ctx.fill();
  ctx.stroke();

  ctx.textAlign = 'center';
  lines.forEach((lineObj, i) => {
    ctx.font = lineObj.font || 'bold 34px Inter, sans-serif';
    ctx.fillStyle = lineObj.color || '#ffffff';
    ctx.fillText(lineObj.text, 256, 58 + i * 52);
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(scaleWidth, scaleWidth * (220 / 512), 1);
  return sprite;
}

function init3DScene() {
  const container = document.getElementById('three-canvas-container');
  if (!container || typeof THREE === 'undefined') return;

  const w = container.clientWidth || 520;
  const h = container.clientHeight || 340;

  threeScene = new THREE.Scene();
  threeCamera = new THREE.PerspectiveCamera(40, w / h, 0.1, 1000);
  threeCamera.position.set(0, 6.2, 14.2);
  threeCamera.lookAt(0, 1.8, 0);

  threeRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  threeRenderer.setSize(w, h);
  threeRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.insertBefore(threeRenderer.domElement, container.firstChild);

  const ambient = new THREE.AmbientLight(0xffffff, 0.85);
  threeScene.add(ambient);

  const dirLight = new THREE.DirectionalLight(0x7dd3fc, 1.4);
  dirLight.position.set(8, 15, 11);
  threeScene.add(dirLight);

  const gridHelper = new THREE.GridHelper(15, 15, 0x38bdf8, 0x1e293b);
  gridHelper.position.y = -0.8;
  threeScene.add(gridHelper);

  threeBarsGroup = new THREE.Group();
  threeScene.add(threeBarsGroup);

  // Mouse drag to rotate
  container.addEventListener('mousedown', (e) => {
    isDragging3D = true;
    prevMouseX = e.clientX;
    prevMouseY = e.clientY;
  });
  window.addEventListener('mouseup', () => { isDragging3D = false; });
  window.addEventListener('mousemove', (e) => {
    if (!isDragging3D) return;
    const dx = e.clientX - prevMouseX;
    const dy = e.clientY - prevMouseY;
    targetRotY += dx * 0.008;
    targetRotX = Math.max(-0.25, Math.min(0.75, targetRotX + dy * 0.006));
    prevMouseX = e.clientX;
    prevMouseY = e.clientY;
  });

  // Mouse wheel to zoom in/out
  container.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoom3D(e.deltaY > 0 ? 1.1 : -1.1);
  }, { passive: false });

  window.addEventListener('resize', resize3DScene);

  function animate3D() {
    requestAnimationFrame(animate3D);
    if (threeBarsGroup) {
      if (AppState.autoRotate3D && !isDragging3D) {
        targetRotY += 0.0022;
      }
      threeBarsGroup.rotation.y += (targetRotY - threeBarsGroup.rotation.y) * 0.1;
      threeBarsGroup.rotation.x += (targetRotX - threeBarsGroup.rotation.x) * 0.1;
    }
    threeRenderer.render(threeScene, threeCamera);
  }
  animate3D();
}

function resize3DScene() {
  const container = document.getElementById('three-canvas-container');
  if (!container || !threeRenderer || !threeCamera) return;
  const w = container.clientWidth || 520;
  const h = container.clientHeight || 340;
  threeCamera.aspect = w / h;
  threeCamera.updateProjectionMatrix();
  threeRenderer.setSize(w, h);
}

function toggle3DRotation() {
  AppState.autoRotate3D = !AppState.autoRotate3D;
  const btn = document.getElementById('btn-3d-pause');
  if (btn) {
    btn.textContent = AppState.autoRotate3D ? '⏸️ Dừng Xoay' : '▶️ Tự Xoay';
    btn.classList.toggle('active', AppState.autoRotate3D);
  }
}

function zoom3D(deltaZ) {
  if (!threeCamera) return;
  threeCamera.position.z = Math.max(6.5, Math.min(26, threeCamera.position.z + deltaZ));
}

function reset3DView() {
  targetRotY = 0.0;
  targetRotX = 0.15;
  if (threeCamera) {
    threeCamera.position.set(0, 6.2, 13.8);
    threeCamera.lookAt(0, 1.8, 0);
  }
  AppState.autoRotate3D = false;
  const btn = document.getElementById('btn-3d-pause');
  if (btn) {
    btn.textContent = '▶️ Tự Xoay';
    btn.classList.remove('active');
  }
}

function toggleExpand3DPanel() {
  const panel = document.getElementById('panel-3d-main');
  if (!panel) return;
  panel.classList.toggle('expanded-3d');
  setTimeout(resize3DScene, 60);
}

function update3DScene(r) {
  if (!threeBarsGroup) return;
  while (threeBarsGroup.children.length > 0) {
    threeBarsGroup.remove(threeBarsGroup.children[0]);
  }

  if (!r || r.matrixRows.length === 0) return;

  const maxLog = Math.max(...r.matrixRows.map((m) => Math.log10(m.stockQty + 10)), 1);
  const spacing = 2.35;
  const startX = -((r.matrixRows.length - 1) * spacing) / 2;

  r.matrixRows.forEach((m, idx) => {
    const xBase = startX + idx * spacing;
    const scanH = m.scannedQty > 0 ? Math.max(0.45, (Math.log10(m.scannedQty + 1) / maxLog) * 4.6) : 0.08;
    const missH = m.missingQty > 0 ? Math.max(0.35, (Math.log10(m.missingQty + 1) / maxLog) * 3.8) : 0.08;
    const pct = m.stockQty > 0 ? ((m.scannedQty / m.stockQty) * 100).toFixed(1) : '0.0';

    // 1. Scanned 3D Pillar (Emerald)
    const geoScan = new THREE.BoxGeometry(0.68, scanH, 0.68);
    const matScan = new THREE.MeshStandardMaterial({
      color: 0x10b981,
      emissive: 0x064e3b,
      roughness: 0.25,
      metalness: 0.35
    });
    const meshScan = new THREE.Mesh(geoScan, matScan);
    meshScan.position.set(xBase - 0.38, -0.8 + scanH / 2, 0);
    threeBarsGroup.add(meshScan);

    // 2. Missing 3D Pillar (Rose)
    const geoMiss = new THREE.BoxGeometry(0.68, missH, 0.68);
    const matMiss = new THREE.MeshStandardMaterial({
      color: 0xf43f5e,
      emissive: 0x881337,
      roughness: 0.25,
      metalness: 0.35
    });
    const meshMiss = new THREE.Mesh(geoMiss, matMiss);
    meshMiss.position.set(xBase + 0.38, -0.8 + missH / 2, 0);
    threeBarsGroup.add(meshMiss);

    // 3. Direct Data Label Billboard above the pillar pair showing full numbers!
    const topY = -0.8 + Math.max(scanH, missH) + 0.95;
    const labelSprite = create3DTextSprite([
      { text: `KHO ${m.wh} [${m.prefix}] (${pct}%)`, color: '#7dd3fc', font: 'bold 34px Inter, sans-serif' },
      { text: `✓ Kiểm: ${fmtCompact(m.scannedQty)} (${m.scannedTags} Tag)`, color: '#34d399', font: 'bold 30px Inter, sans-serif' },
      { text: `✗ Thiếu: ${fmtCompact(m.missingQty)} (${m.missingTags} Tag)`, color: '#fb7185', font: 'bold 30px Inter, sans-serif' }
    ], m.missingQty === 0 ? '#10b981' : '#38bdf8', 2.2);
    labelSprite.position.set(xBase, topY, 0);
    threeBarsGroup.add(labelSprite);
  });
}

/* ==========================================================================
   MULTI-SHEET EXCEL EXPORT (XUẤT BÁO CÁO EXCEL 5 SHEET ĐẦY ĐỦ)
   ========================================================================== */
function exportFullExcelReport() {
  const r = AppState.reconciled;
  if (!r) return;

  const wb = XLSX.utils.book_new();

  // SHEET 1: TỔNG HỢP BÁO CÁO LÃNH ĐẠO
  const execRows = [
    ['BÁO CÁO ĐỐI SOÁT TỒN KHO & KIỂM KÊ THỰC TẾ PDA (KHO 01 & 61 | MÃ HÀNG 3*, 5*, 7*)'],
    ['Ngày xuất báo cáo:', new Date().toLocaleString('vi-VN')],
    ['Nguồn Tồn Kho:', AppState.stockFileName, 'Nguồn Kiểm Kê:', AppState.scanFileName],
    [],
    ['CHỈ SỐ KPI TỔNG QUAN', 'GIÁ TRỊ', 'TỶ LỆ / GHI CHÚ'],
    ['1. Tổng Số Lượng Tồn Kho (Kho 01 & 61 | 3*, 5*, 7*)', r.totalStockQty, `${r.totalStockTags} TagID (${r.uniqueItemCodesCount} Mã hàng)`],
    ['2. Số Lượng Kiểm Được (Đã quét khớp TagID)', r.totalScannedQty, fmtPct(r.totalStockQty ? (r.totalScannedQty / r.totalStockQty) * 100 : 0)],
    ['3. Số Lượng Thiếu So Với Tồn Kho (Chưa quét)', r.totalMissingQty, fmtPct(r.totalStockQty ? (r.totalMissingQty / r.totalStockQty) * 100 : 0)],
    ['4. Tổng Số TagID Kiểm Được', r.totalScannedTags, fmtPct(r.totalStockTags ? (r.totalScannedTags / r.totalStockTags) * 100 : 0)],
    ['5. Tổng Số TagID Chưa Kiểm (Thiếu)', r.totalMissingTags, fmtPct(r.totalStockTags ? (r.totalMissingTags / r.totalStockTags) * 100 : 0)],
    ['6. Cảnh Báo TagID Quét Trùng (Đã khử trùng lặp)', r.duplicateAlerts.length, `${r.totalExtraDuplicateScans} lượt quét dư (Ngăn chặn +${fmtNum(r.totalPreventedInflatedQty)} SL ảo)`],
    ['7. Cảnh Báo Lệch Vị Trí (BIN Tồn ≠ Vị Trí Quét)', r.totalLocMismatch, 'TagID khớp nhưng khác vị trí BIN trên sổ'],
    ['8. TagID Ngoài Phạm Vi / Chưa Có Trên Tồn Kho', r.unmatchedAlerts.length, `${r.unmatchedOtherWhCount} thuộc kho/mã khác; ${r.unmatchedUnknownCount} chưa có trên sổ`],
    [],
    ['BẢNG TỔNG HỢP THEO TỪNG KHO (01, 61) & NHÓM MÃ HÀNG (3*, 5*, 7*)'],
    ['Kho (WH)', 'Nhóm Mã Hàng', 'Số Mã Hàng', 'Tổng Tag Tồn', 'Tag Kiểm Được', 'Tag Thiếu', 'Tỷ Lệ Tag (%)', 'Tổng SL Tồn Kho', 'SL Kiểm Được', 'SL Thiếu So Với Tồn', 'Tỷ Lệ Đạt SL (%)']
  ];

  for (const m of r.matrixRows) {
    const tagPct = m.stockTags > 0 ? Number(((m.scannedTags / m.stockTags) * 100).toFixed(2)) : 0;
    const qtyPct = m.stockQty > 0 ? Number(((m.scannedQty / m.stockQty) * 100).toFixed(2)) : 0;
    execRows.push([
      m.wh, m.prefix, m.items.size, m.stockTags, m.scannedTags, m.missingTags, tagPct,
      m.stockQty, m.scannedQty, m.missingQty, qtyPct
    ]);
  }
  const wsExec = XLSX.utils.aoa_to_sheet(execRows);
  XLSX.utils.book_append_sheet(wb, wsExec, '1_Tong_Hop_Bao_Cao');

  // SHEET 2: TỔNG HỢP THEO TỪNG MÃ HÀNG & VỊ TRÍ
  const itemRows = r.itemSummaries.map((it, idx) => ({
    'STT': idx + 1,
    'Kho (Warehouse)': it.wh,
    'Mã Hàng (Stock Code)': it.code,
    'Nhóm Mã': it.prefix,
    'Tổng Tag Tồn': it.stockTags,
    'Tag Kiểm Được': it.scannedTags,
    'Tag Thiếu': it.missingTags,
    'Số Lượng Tồn Kho': it.stockQty,
    'Số Lượng Kiểm Được': it.scannedQty,
    'Số Lượng Thiếu': it.missingQty,
    'Tỷ Lệ Đạt SL (%)': Number(it.pctQty.toFixed(2)),
    'Vị Trí Tồn Sổ (BIN)': it.binsStr,
    'Vị Trí Quét Thực Tế': it.scanLocsStr,
    'Số Tag Quét Trùng': it.dupTags,
    'Số Tag Lệch Vị Trí': it.locDiffTags,
    'Trạng Thái Đối Soát': it.missingTags === 0 ? 'Đã kiểm đủ 100%' : `Thiếu ${it.missingTags} Tag (${fmtNum(it.missingQty)} SL)`
  }));
  const wsItems = XLSX.utils.json_to_sheet(itemRows);
  XLSX.utils.book_append_sheet(wb, wsItems, '2_Theo_Ma_Hang_Vi_Tri');

  // SHEET 3: CHI TIẾT ĐỐI SOÁT TỪNG TAGID / BATCH
  const detailRows = r.tagDetails.map((td, idx) => ({
    'STT': idx + 1,
    'Kho (Warehouse)': td.wh,
    'Mã Hàng (Stock Code)': td.code,
    'Nhóm Mã': td.prefix,
    'TagID / Batch': td.batch,
    'Số Lượng Tồn Kho': td.stockQty,
    'Số Lượng Kiểm Được': td.scannedQty,
    'Số Lượng Thiếu': td.missingQty,
    'Vị Trí Sổ (BIN)': td.bin,
    'Vị Trí Quét PDA': td.scanLoc,
    'Số Lần Quét PDA': td.scanCount,
    'User Quét': td.user,
    'Thời Gian Quét': td.time,
    'Trạng Thái Đối Soát': td.statusLabel
  }));
  const wsDetails = XLSX.utils.json_to_sheet(detailRows);
  XLSX.utils.book_append_sheet(wb, wsDetails, '3_Chi_Tiet_TagID');

  // SHEET 4: CẢNH BÁO TRÙNG TAGID & NGOẠI LỆ
  const alertRows = [];
  for (const d of r.duplicateAlerts) {
    alertRows.push({
      'Loại Cảnh Báo': 'TRÙNG TAGID (DUPLICATE)',
      'TagID / Batch': d.tag,
      'Số Lần Quét': d.count,
      'Kho': d.wh,
      'Mã Hàng': d.code,
      'SL Gốc (1 Tag)': d.unitQty,
      'SL Ảo Đã Chặn': d.preventedQty,
      'BIN Tồn Kho': d.bin,
      'Chi Tiết Lượt Quét / Ngoại Lệ': d.scans.map((s) => `STT ${s.stt}: ${s.user} @ ${s.loc} (${s.time})`).join(' | ')
    });
  }
  for (const u of r.unmatchedAlerts) {
    alertRows.push({
      'Loại Cảnh Báo': u.typeLabel,
      'TagID / Batch': u.tag,
      'Số Lần Quét': u.count,
      'Kho': '-',
      'Mã Hàng': '-',
      'SL Gốc (1 Tag)': 0,
      'SL Ảo Đã Chặn': 0,
      'BIN Tồn Kho': u.loc,
      'Chi Tiết Lượt Quét / Ngoại Lệ': `${u.user} @ ${u.loc} (${u.time}) -> ${u.info}`
    });
  }
  const wsAlerts = XLSX.utils.json_to_sheet(alertRows);
  XLSX.utils.book_append_sheet(wb, wsAlerts, '4_Canh_Bao_Trung_TagID');

  // SHEET 5: DỮ LIỆU QUÉT PDA
  const pdaRows = AppState.scanRaw.map((s, idx) => {
    const st = r.filteredStockByBatch.get(s.tag);
    return {
      'Thứ Tự Dòng': idx + 1,
      'STT Gốc': s.stt,
      'Tag ID': s.tag,
      'Bin Location': s.loc,
      'USE': s.user,
      'Thời Gian Quét (PDA)': s.time,
      'Mã Hàng Khớp': st ? st.code : 'Ngoài phạm vi',
      'Kho Khớp': st ? st.wh : '-',
      'Qty': (Number(s.manualQty) > 0) ? Number(s.manualQty) : (st ? st.qty : 0)
    };
  });
  const wsPda = XLSX.utils.json_to_sheet(pdaRows);
  XLSX.utils.book_append_sheet(wb, wsPda, '5_Du_Lieu_Quet_PDA');

  XLSX.writeFile(wb, 'Bao_Cao_Doi_Soat_Ton_Kho_31.10.2026.xlsx');
}

function exportPdaScansOnly() {
  const r = AppState.reconciled;
  const wb = XLSX.utils.book_new();
  const pdaRows = AppState.scanRaw.map((s, idx) => {
    const st = r ? r.filteredStockByBatch.get(s.tag) : null;
    return {
      'STT': idx + 1,
      'Tag ID': s.tag,
      'Bin Location': s.loc,
      'USE': s.user,
      'Qty': (Number(s.manualQty) > 0) ? Number(s.manualQty) : (st ? st.qty : 0),
      'Thời gian quét (PDA)': s.time,
      'Mã hàng': st ? st.code : ''
    };
  });
  const ws = XLSX.utils.json_to_sheet(pdaRows);
  XLSX.utils.book_append_sheet(wb, ws, 'Du_Lieu_Quet_PDA');
  XLSX.writeFile(wb, 'File_Quet_PDA_Nguon.xlsx');
}

/* ==========================================================================
   FILTER & TAB HANDLERS
   ========================================================================== */
function setWarehouseFilter(wh, btnEl) {
  AppState.whFilter = wh;
  document.querySelectorAll('[data-wh]').forEach((b) => b.classList.remove('active'));
  if (btnEl) btnEl.classList.add('active');
  runMultiAgentReconciliation();
}

function setPrefixFilter(pfx, btnEl) {
  AppState.pfxFilter = pfx;
  document.querySelectorAll('[data-pfx]').forEach((b) => b.classList.remove('active'));
  if (btnEl) btnEl.classList.add('active');
  runMultiAgentReconciliation();
}

function setStatusFilter(st, btnEl) {
  AppState.statusFilter = st;
  document.querySelectorAll('#status-filter-buttons .chip-btn').forEach((b) => b.classList.remove('active'));
  if (btnEl) btnEl.classList.add('active');
  renderActiveTables();
}

function filterDetailByStatus(st) {
  switchTab('tab-details');
  AppState.statusFilter = st;
  renderActiveTables();
}

function handleGlobalSearch(val) {
  AppState.searchQuery = val || '';
  renderActiveTables();
}

function switchTab(tabId) {
  AppState.activeTab = tabId;
  document.querySelectorAll('.tab-pane').forEach((el) => {
    el.style.display = el.id === tabId ? 'block' : 'none';
  });
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
  });
}

/* ==========================================================================
   INITIALIZATION & AGENT-COMPATIBLE API
   ========================================================================== */
function loadInitialBundle() {
  if (Array.isArray(window.DEFAULT_STOCK_DATA)) {
    AppState.stockRaw = window.DEFAULT_STOCK_DATA.map((r) => ({
      code: r[0],
      wh: r[1],
      date: r[2],
      batch: r[3],
      bin: r[4],
      qty: Number(r[5]) || 0
    }));
    AppState.stockFileName = 'Stock list.xlsx (24,961 dòng)';
  }
  if (Array.isArray(window.DEFAULT_SCAN_DATA)) {
    AppState.scanRaw = window.DEFAULT_SCAN_DATA.map((r) => ({
      stt: r[0],
      tag: r[1],
      loc: r[2],
      user: r[3],
      time: r[4],
      manualQty: 0,
      isNew: false
    }));
    AppState.scanFileName = 'kiêm kho 31.10.2026.xlsx (3,886 dòng)';
  }
}

window.InventoryAgentAPI = {
  getState: () => AppState,
  getReconciledSummary: () => AppState.reconciled,
  clearStockData,
  clearScanData,
  clearAllSources,
  restoreDefaultData,
  scanTagFromPDA: (user, loc, tag, qty) => {
    document.getElementById('pda-input-user').value = user || 'Agent';
    document.getElementById('pda-input-loc').value = loc || '';
    document.getElementById('pda-input-tag').value = tag || '';
    document.getElementById('pda-input-qty').value = qty || '';
    submitPdaScan();
  },
  editPdaRow,
  deletePdaRow,
  exportFullExcelReport
};

window.addEventListener('DOMContentLoaded', () => {
  init3DScene();
  loadInitialBundle();
  runMultiAgentReconciliation();
  if (window.location.hash === '#pda' || window.AUTO_OPEN_PDA_MODAL) {
    openPdaModal();
  }
});
