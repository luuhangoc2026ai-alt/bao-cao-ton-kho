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
  scanRaw: [],          // Array of { scanId, stt, tag, loc, user, time, manualQty, isNew, source, offlineQueued, syncStatus, syncedAt }
  stockFileName: 'Stock list.xlsx',
  scanFileName: 'kiêm kho 31.10.2026.xlsx',
  scanSources: ['kiêm kho 31.10.2026.xlsx'],

  // Active UI Filters
  whFilter: 'ALL',      // 'ALL', '01', '61'
  pfxFilter: 'ALL',     // 'ALL', '3', '5', '7'
  statusFilter: 'ALL',  // 'ALL', 'MISSING', 'COMPLETE', 'OTHER_WH', 'DUP', 'LOC_DIFF'
  searchQuery: '',
  activeTab: 'tab-items',

  // PDA Editing State (-1 = New Scan, >=0 = Editing existing row; editingScanId = immutable lock-free ID)
  editingScanIndex: -1,
  editingScanId: null,
  scanSeqCounter: 0,

  // Multi-User Concurrency & Offline/Online Sync State
  isOnline: typeof navigator !== 'undefined' ? navigator.onLine !== false : true,
  manualOfflineMode: false,
  offlineActivityLog: [], // Array of { id, action, scanId, tag, loc, user, qty, time, synced, syncedAt }
  syncHistory: [],        // Array of { syncTime, syncedScansCount, syncedActivitiesCount, users }

  // Chart & 3D State
  mainChartMode: 'combo', // 'combo' | 'line' | 'bar'
  autoRotate3D: true,

  // Computed Reconciliation Result
  reconciled: null
};

const STORAGE_KEYS = {
  SHARED_SCANS: 'ZEBRA_PDA_SHARED_SCANS_V1',
  OFFLINE_QUEUE: 'ZEBRA_PDA_OFFLINE_QUEUE_V1',
  ACTIVITY_LOG: 'ZEBRA_PDA_ACTIVITY_LOG_V1',
  DELETED_IDS: 'ZEBRA_PDA_DELETED_IDS_V1'
};

let pdaBroadcastChannel = null;
try {
  if (typeof BroadcastChannel !== 'undefined') {
    pdaBroadcastChannel = new BroadcastChannel('zebra_pda_multiuser_channel');
  }
} catch (_) {}

function generateScanId(user = 'USER', prefix = 'SCAN') {
  AppState.scanSeqCounter = (AppState.scanSeqCounter || 0) + 1;
  const cleanUser = String(user || 'U').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'U';
  const rand = Math.random().toString(36).slice(2, 7);
  return `${prefix}-${Date.now()}-${AppState.scanSeqCounter}-${rand}-${cleanUser}`;
}

function isEffectiveOnline() {
  return Boolean(AppState.isOnline && !AppState.manualOfflineMode);
}

function getNowTimeStr() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function safeReadStorageArray(key) {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function safeWriteStorageArray(key, arr) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, JSON.stringify(arr));
  } catch (_) {}
}

function getPendingOfflineScansCount() {
  const inMemPending = AppState.scanRaw.filter((s) => s.offlineQueued || s.syncStatus === 'OFFLINE_PENDING').length;
  const queuedStorage = safeReadStorageArray(STORAGE_KEYS.OFFLINE_QUEUE).length;
  return Math.max(inMemPending, queuedStorage);
}

function findScanIndexById(scanId, fallbackIdx = -1) {
  if (scanId) {
    const idx = AppState.scanRaw.findIndex((s) => s.scanId === scanId);
    if (idx !== -1) return idx;
  }
  if (fallbackIdx >= 0 && fallbackIdx < AppState.scanRaw.length) {
    return fallbackIdx;
  }
  return -1;
}

function recordPdaActivity(action, scanRecord) {
  const entry = {
    id: generateScanId(scanRecord.user, 'ACT'),
    action, // 'SCAN_OFFLINE' | 'SCAN_ONLINE' | 'EDIT' | 'DELETE' | 'SYNC'
    scanId: scanRecord.scanId || '',
    tag: scanRecord.tag || '',
    loc: scanRecord.loc || '-',
    user: scanRecord.user || 'USER',
    qty: Number(scanRecord.manualQty) || 0,
    time: scanRecord.time || getNowTimeStr(),
    synced: isEffectiveOnline(),
    syncedAt: isEffectiveOnline() ? getNowTimeStr() : null
  };
  AppState.offlineActivityLog.unshift(entry);
  const storedLog = safeReadStorageArray(STORAGE_KEYS.ACTIVITY_LOG);
  storedLog.unshift(entry);
  safeWriteStorageArray(STORAGE_KEYS.ACTIVITY_LOG, storedLog.slice(0, 5000));
}

function persistMultiUserAndOfflineScan(scanRecord, mode = 'UPSERT') {
  const deletedSet = new Set(safeReadStorageArray(STORAGE_KEYS.DELETED_IDS));

  if (mode === 'DELETE') {
    if (scanRecord && scanRecord.scanId) {
      deletedSet.add(scanRecord.scanId);
      safeWriteStorageArray(STORAGE_KEYS.DELETED_IDS, Array.from(deletedSet));
    }
    const shared = safeReadStorageArray(STORAGE_KEYS.SHARED_SCANS).filter((x) => x.scanId !== scanRecord.scanId);
    safeWriteStorageArray(STORAGE_KEYS.SHARED_SCANS, shared);
    const offlineQ = safeReadStorageArray(STORAGE_KEYS.OFFLINE_QUEUE).filter((x) => x.scanId !== scanRecord.scanId);
    safeWriteStorageArray(STORAGE_KEYS.OFFLINE_QUEUE, offlineQ);
  } else {
    // Atomic upsert by scanId in shared multi-user log
    const shared = safeReadStorageArray(STORAGE_KEYS.SHARED_SCANS).filter((x) => !deletedSet.has(x.scanId));
    const existIdx = shared.findIndex((x) => x.scanId === scanRecord.scanId);
    if (existIdx >= 0) {
      shared[existIdx] = { ...shared[existIdx], ...scanRecord };
    } else {
      shared.unshift({ ...scanRecord });
    }
    safeWriteStorageArray(STORAGE_KEYS.SHARED_SCANS, shared);

    if (!isEffectiveOnline() || scanRecord.offlineQueued) {
      const offlineQ = safeReadStorageArray(STORAGE_KEYS.OFFLINE_QUEUE).filter((x) => !deletedSet.has(x.scanId));
      const qIdx = offlineQ.findIndex((x) => x.scanId === scanRecord.scanId);
      if (qIdx >= 0) {
        offlineQ[qIdx] = { ...offlineQ[qIdx], ...scanRecord };
      } else {
        offlineQ.unshift({ ...scanRecord });
      }
      safeWriteStorageArray(STORAGE_KEYS.OFFLINE_QUEUE, offlineQ);
    }
  }

  // Broadcast to other concurrent PDA users/tabs if online
  if (isEffectiveOnline() && pdaBroadcastChannel) {
    try {
      pdaBroadcastChannel.postMessage({
        type: 'PDA_MULTIUSER_EVENT',
        mode,
        record: scanRecord,
        timestamp: Date.now()
      });
    } catch (_) {}
  }
}

function mergeExternalMultiUserScans(triggerReconcile = true) {
  const deletedSet = new Set(safeReadStorageArray(STORAGE_KEYS.DELETED_IDS));
  const shared = safeReadStorageArray(STORAGE_KEYS.SHARED_SCANS);
  const offlineQ = safeReadStorageArray(STORAGE_KEYS.OFFLINE_QUEUE);
  const combinedExternal = [...offlineQ, ...shared];

  let changed = false;
  // Remove any deleted scanId
  if (deletedSet.size > 0) {
    const beforeLen = AppState.scanRaw.length;
    AppState.scanRaw = AppState.scanRaw.filter((s) => !deletedSet.has(s.scanId));
    if (AppState.scanRaw.length !== beforeLen) changed = true;
  }

  const byId = new Map();
  for (let i = 0; i < AppState.scanRaw.length; i++) {
    const s = AppState.scanRaw[i];
    if (!s.scanId) s.scanId = generateScanId(s.user || 'INIT', 'BASE');
    byId.set(s.scanId, i);
  }

  // Insert or update from external multi-user/offline records in chronological order
  for (let i = combinedExternal.length - 1; i >= 0; i--) {
    const ext = combinedExternal[i];
    if (!ext || !ext.scanId || deletedSet.has(ext.scanId)) continue;
    if (byId.has(ext.scanId)) {
      const idx = byId.get(ext.scanId);
      const cur = AppState.scanRaw[idx];
      if (cur.tag !== ext.tag || cur.loc !== ext.loc || cur.user !== ext.user || cur.manualQty !== ext.manualQty || cur.syncStatus !== ext.syncStatus) {
        AppState.scanRaw[idx] = { ...cur, ...ext };
        changed = true;
      }
    } else {
      AppState.scanRaw.unshift({ ...ext });
      byId.set(ext.scanId, 0);
      changed = true;
    }
  }

  if (changed && triggerReconcile) {
    if (!AppState.scanSources.includes('Máy quét PDA')) {
      AppState.scanSources.push('Máy quét PDA');
    }
    refreshScanFileNameLabel();
    runMultiAgentReconciliation();
  }
  return changed;
}

// Formatters
const fmtNum = (n) => Number(n || 0).toLocaleString('vi-VN');
const fmtSignedNum = (n) => {
  const v = Number(n || 0);
  if (v > 0) return '+' + v.toLocaleString('vi-VN');
  return v.toLocaleString('vi-VN');
};
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

function isTargetPrefix(code) {
  const c = String(code || '').trim();
  return c.startsWith('3') || c.startsWith('5') || c.startsWith('7');
}

function isTargetScope(wh, code) {
  const w = normalizeWh(wh);
  return (w === '01' || w === '61') && isTargetPrefix(code);
}

/* ==========================================================================
   MULTI-AGENT RECONCILIATION ENGINE
   ========================================================================== */
function runMultiAgentReconciliation() {
  // AGENT 1: Stock Scope Filter (Kho 01 & 61, Item Code 3*, 5*, 7*) + All-Warehouse Stock Index
  const filteredStock = [];
  const filteredStockByBatch = new Map();
  const otherStockByBatch = new Map();
  const allWhPositiveStockByCode = new Map(); // code -> { totalQty, totalTags, whSet }
  const stock0161ByCode = new Map();          // code -> { totalQty, totalTags, whSet }
  let totalAllWhPositiveStockQty357 = 0;

  for (const row of AppState.stockRaw) {
    const code = String(row.code || '').trim();
    const wh = normalizeWh(row.wh);
    const batch = String(row.batch || '').trim();
    const bin = String(row.bin || '').trim();
    const qty = Number(row.qty) || 0;
    const item = { code, wh, date: row.date || '', batch, bin, qty };

    if (code && qty > 0) {
      if (!allWhPositiveStockByCode.has(code)) {
        allWhPositiveStockByCode.set(code, { totalQty: 0, totalTags: 0, whSet: new Set() });
      }
      const ac = allWhPositiveStockByCode.get(code);
      ac.totalQty += qty;
      ac.totalTags++;
      ac.whSet.add(wh);
      if (isTargetPrefix(code)) {
        totalAllWhPositiveStockQty357 += qty;
      }
    }

    if (!batch) continue;
    if (isTargetScope(wh, code)) {
      filteredStock.push(item);
      filteredStockByBatch.set(batch, item);
      if (!stock0161ByCode.has(code)) {
        stock0161ByCode.set(code, { totalQty: 0, totalTags: 0, whSet: new Set() });
      }
      const sc = stock0161ByCode.get(code);
      sc.totalQty += qty;
      sc.totalTags++;
      sc.whSet.add(wh);
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

  // Detect unmatched / out-of-scope scan tags & aggregate Scanned Tags in Other Warehouses
  const unmatchedAlerts = [];
  let unmatchedOtherWhCount = 0;
  let unmatchedOtherWhQty = 0;
  let otherWhSamePfxTags = 0;
  let otherWhSamePfxQty = 0;
  let otherPfxTags = 0;
  let otherPfxQty = 0;
  let unmatchedUnknownCount = 0;
  let unmatchedUnknownQty = 0;

  const otherWhByCodeMap = new Map();      // code -> { code, prefix, isTargetPfx, otherWhs: Set, otherWhTags, otherWhQty, scanLocs: Set, tagList: [] }
  const otherWhByWarehouseMap = new Map(); // key -> { wh, categoryLabel, isTargetPfx, codes: Set, tags, qty }

  for (const [tag, scans] of scanByTag.entries()) {
    if (!filteredStockByBatch.has(tag)) {
      const otherMatches = otherStockByBatch.get(tag);
      if (otherMatches && otherMatches.length > 0) {
        const first = otherMatches[0];
        const unitQty = (Number(scans[0].manualQty) > 0) ? Number(scans[0].manualQty) : (Number(first.qty) || 0);
        const isTgtPfx = isTargetPrefix(first.code);
        const isOtherWh = first.wh !== '01' && first.wh !== '61';
        const pfxLabel = first.code ? `${first.code.charAt(0)}*` : 'Khác';

        // Apply active UI prefix filter if user selected a specific prefix (3, 5, 7)
        if (AppState.pfxFilter !== 'ALL' && !first.code.startsWith(AppState.pfxFilter)) {
          continue;
        }

        unmatchedOtherWhCount++;
        unmatchedOtherWhQty += unitQty;

        if (isTgtPfx && isOtherWh) {
          otherWhSamePfxTags++;
          otherWhSamePfxQty += unitQty;
        } else {
          otherPfxTags++;
          otherPfxQty += unitQty;
        }

        const typeCode = (isTgtPfx && isOtherWh) ? 'OTHER_WH' : 'OTHER_PREFIX';
        const typeLabel = (isTgtPfx && isOtherWh)
          ? `Đang Ở Kho Khác (Kho ${first.wh})`
          : `Khác Nhóm Mã (Kho ${first.wh} | Mã ${pfxLabel})`;

        unmatchedAlerts.push({
          tag,
          wh: first.wh,
          code: first.code,
          prefix: pfxLabel,
          qty: unitQty,
          bin: first.bin || '-',
          loc: scans[0].loc,
          user: scans[0].user,
          time: scans[0].time,
          count: scans.length,
          type: typeCode,
          typeLabel,
          info: `Sổ Tồn: Kho ${first.wh} | Mã ${first.code} | BIN: ${first.bin || '-'} | SL: ${fmtNum(unitQty)}`
        });

        // Aggregate by Item Code
        if (!otherWhByCodeMap.has(first.code)) {
          otherWhByCodeMap.set(first.code, {
            code: first.code,
            prefix: pfxLabel,
            isTargetPfx: isTgtPfx,
            otherWhs: new Set(),
            otherWhTags: 0,
            otherWhQty: 0,
            scanLocs: new Set(),
            tagList: []
          });
        }
        const cg = otherWhByCodeMap.get(first.code);
        cg.otherWhs.add(first.wh);
        cg.otherWhTags++;
        cg.otherWhQty += unitQty;
        for (const sc of scans) {
          if (sc.loc) cg.scanLocs.add(sc.loc);
        }
        cg.tagList.push({
          tag,
          wh: first.wh,
          qty: unitQty,
          bin: first.bin || '-',
          scanLoc: scans[0].loc || '-',
          user: scans[0].user || '-',
          time: scans[0].time || '-'
        });

        // Aggregate by Warehouse on Book
        const whGroupKey = `${first.wh}__${isTgtPfx ? '357' : 'OTHER'}`;
        if (!otherWhByWarehouseMap.has(whGroupKey)) {
          otherWhByWarehouseMap.set(whGroupKey, {
            wh: first.wh,
            isTargetPfx: isTgtPfx,
            categoryLabel: isTgtPfx ? `Mã chuẩn (3*, 5*, 7*) đang ở Kho ${first.wh}` : `Mã nhóm khác (${pfxLabel}) tại Kho ${first.wh}`,
            codes: new Set(),
            tags: 0,
            qty: 0
          });
        }
        const wg = otherWhByWarehouseMap.get(whGroupKey);
        wg.codes.add(first.code);
        wg.tags++;
        wg.qty += unitQty;
      } else {
        const manualQ = Number(scans[0].manualQty) || 0;
        unmatchedUnknownCount++;
        unmatchedUnknownQty += manualQ;
        unmatchedAlerts.push({
          tag,
          wh: '-',
          code: 'Chưa có trên sổ',
          prefix: '-',
          qty: manualQ,
          bin: '-',
          loc: scans[0].loc,
          user: scans[0].user,
          time: scans[0].time,
          count: scans.length,
          type: 'NOT_IN_STOCK',
          typeLabel: 'Chưa Có Trên Danh Sách Tồn Kho',
          info: manualQ > 0 ? `SL nhập PDA: ${fmtNum(manualQ)}` : 'Không tìm thấy TagID trong Stock List'
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
  const scanned0161ByCode = new Map(); // code -> { scannedQty, scannedTags }

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

      if (!scanned0161ByCode.has(st.code)) {
        scanned0161ByCode.set(st.code, { scannedQty: 0, scannedTags: 0 });
      }
      const sc = scanned0161ByCode.get(st.code);
      sc.scannedQty += scannedQty;
      sc.scannedTags++;
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
        otherWhTags: 0,
        otherWhQty: 0,
        otherWhsStr: '-',
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

  // Attach other-warehouse scanned tags (3*, 5*, 7*) to itemMap so Tab 1 & Executive Matrix reconcile against total stock
  for (const [code, cg] of otherWhByCodeMap.entries()) {
    if (!cg.isTargetPfx) continue;
    const otherWhsStr = Array.from(cg.otherWhs).map((w) => `Kho ${w}`).join(', ');
    // Prefer attaching to Kho 61 if present (since physical scans in other WH were scanned at Kho 61 bins), else Kho 01
    let targetGrp = itemMap.get(`61__${code}`) || itemMap.get(`01__${code}`);
    if (!targetGrp && AppState.whFilter !== '01') {
      const newKey = `61__${code}`;
      targetGrp = {
        wh: '61',
        code,
        prefix: cg.prefix,
        stockTags: 0,
        scannedTags: 0,
        missingTags: 0,
        stockQty: 0,
        scannedQty: 0,
        missingQty: 0,
        otherWhTags: 0,
        otherWhQty: 0,
        otherWhsStr: '-',
        dupTags: 0,
        locDiffTags: 0,
        bins: new Set(),
        scanLocs: new Set()
      };
      itemMap.set(newKey, targetGrp);
    }
    if (targetGrp) {
      targetGrp.otherWhTags += cg.otherWhTags;
      targetGrp.otherWhQty += cg.otherWhQty;
      targetGrp.otherWhsStr = otherWhsStr;
      for (const loc of cg.scanLocs) {
        if (loc) targetGrp.scanLocs.add(loc);
      }
    }
  }

  const itemSummaries = Array.from(itemMap.values()).map((g) => {
    const totalScannedWithOtherWh = g.scannedQty + g.otherWhQty;
    const netDiffWithOtherWh = totalScannedWithOtherWh - g.stockQty;
    const pctQty = g.stockQty > 0 ? (g.scannedQty / g.stockQty) * 100 : (g.otherWhQty > 0 ? 100 : 0);
    const pctQtyWithOtherWh = g.stockQty > 0 ? (totalScannedWithOtherWh / g.stockQty) * 100 : (g.otherWhQty > 0 ? 100 : 0);
    const allWhInfo = allWhPositiveStockByCode.get(g.code);
    return {
      ...g,
      totalScannedWithOtherWh,
      netDiffWithOtherWh,
      pctQty,
      pctQtyWithOtherWh,
      allWhStockQty: allWhInfo ? allWhInfo.totalQty : g.stockQty,
      binsStr: Array.from(g.bins).join(', ') || '-',
      scanLocsStr: Array.from(g.scanLocs).join(', ') || '-'
    };
  }).sort((a, b) => b.missingQty - a.missingQty || b.otherWhQty - a.otherWhQty || b.stockQty - a.stockQty);

  // Build Tab 4.1 (otherWhSummaryRows) and Tab 4.2 (otherWhItemRows)
  const otherWhSummaryRows = Array.from(otherWhByWarehouseMap.values()).map((wg) => {
    let stock0161Qty = 0;
    let scanned0161Qty = 0;
    let allWhStockQty = 0;
    for (const c of wg.codes) {
      const s0161 = stock0161ByCode.get(c);
      if (s0161) stock0161Qty += s0161.totalQty;
      const sc0161 = scanned0161ByCode.get(c);
      if (sc0161) scanned0161Qty += sc0161.scannedQty;
      const allW = allWhPositiveStockByCode.get(c);
      if (allW) allWhStockQty += allW.totalQty;
    }
    return {
      wh: wg.wh,
      isTargetPfx: wg.isTargetPfx,
      categoryLabel: wg.categoryLabel,
      codesCount: wg.codes.size,
      scannedTags: wg.tags,
      scannedQty: wg.qty,
      stock0161Qty,
      scanned0161Qty,
      totalScannedCombined: scanned0161Qty + wg.qty,
      allWhStockQty
    };
  }).sort((a, b) => (b.isTargetPfx - a.isTargetPfx) || (b.scannedQty - a.scannedQty));

  const otherWhItemRows = Array.from(otherWhByCodeMap.values()).map((cg) => {
    const s0161 = stock0161ByCode.get(cg.code) || { totalQty: 0, totalTags: 0 };
    const sc0161 = scanned0161ByCode.get(cg.code) || { scannedQty: 0, scannedTags: 0 };
    const allW = allWhPositiveStockByCode.get(cg.code) || { totalQty: s0161.totalQty, totalTags: s0161.totalTags };
    const missing0161Qty = Math.max(0, s0161.totalQty - sc0161.scannedQty);
    const totalScannedInclOtherWh = sc0161.scannedQty + cg.otherWhQty;
    const diffVs0161Stock = totalScannedInclOtherWh - s0161.totalQty;
    const diffVsAllWhStock = totalScannedInclOtherWh - allW.totalQty;
    return {
      code: cg.code,
      prefix: cg.prefix,
      isTargetPfx: cg.isTargetPfx,
      otherWhsStr: Array.from(cg.otherWhs).map((w) => `Kho ${w}`).join(', '),
      otherWhTags: cg.otherWhTags,
      otherWhQty: cg.otherWhQty,
      stock0161Tags: s0161.totalTags,
      stock0161Qty: s0161.totalQty,
      scanned0161Tags: sc0161.scannedTags,
      scanned0161Qty: sc0161.scannedQty,
      missing0161Qty,
      totalScannedInclOtherWh,
      diffVs0161Stock,
      allWhStockQty: allW.totalQty,
      diffVsAllWhStock,
      tagList: cg.tagList
    };
  }).sort((a, b) => (b.isTargetPfx - a.isTargetPfx) || (b.otherWhQty - a.otherWhQty));

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
      missingQty: 0,
      otherWhTags: 0,
      otherWhQty: 0
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

  // Add other-warehouse scanned tags (3*, 5*, 7*) to the corresponding matrix rows
  for (const it of itemSummaries) {
    if (it.otherWhTags > 0) {
      const key = `${it.wh}_${it.prefix}`;
      if (matrixMap.has(key)) {
        const m = matrixMap.get(key);
        m.otherWhTags += it.otherWhTags;
        m.otherWhQty += it.otherWhQty;
      }
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
  const activeOtherWhTags = AppState.whFilter === '01' ? 0 : otherWhSamePfxTags;
  const activeOtherWhQty = AppState.whFilter === '01' ? 0 : otherWhSamePfxQty;
  const totalScannedInclOtherWhQty = totalScannedQty + activeOtherWhQty;
  const totalScannedInclAllMatchedQty = totalScannedQty + unmatchedOtherWhQty;
  const netDiffAfterOtherWhQty = totalScannedInclOtherWhQty - totalStockQty;
  const netDiffAfterAllMatchedQty = totalScannedInclAllMatchedQty - totalStockQty;

  AppState.reconciled = {
    filteredStockCountAll: filteredStock.length,
    filteredStockQtyAll: filteredStock.reduce((acc, x) => acc + x.qty, 0),
    totalAllWhPositiveStockQty357,
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
    unmatchedOtherWhQty,
    otherWhSamePfxTags: activeOtherWhTags,
    otherWhSamePfxQty: activeOtherWhQty,
    otherPfxTags,
    otherPfxQty,
    unmatchedUnknownCount,
    unmatchedUnknownQty,
    totalScannedInclOtherWhQty,
    totalScannedInclAllMatchedQty,
    netDiffAfterOtherWhQty,
    netDiffAfterAllMatchedQty,
    otherWhSummaryRows,
    otherWhItemRows,
    itemSummaries,
    tagDetails,
    matrixRows: Array.from(matrixMap.values()).filter((m) => m.stockTags > 0 || m.otherWhTags > 0),
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
    ? `Khớp ${fmtNum(r.totalScannedTags)} Tag + ${fmtNum(r.otherWhSamePfxTags)} Tag kho khác (${fmtNum(r.totalScannedInclOtherWhQty)} SL)`
    : 'Chờ dữ liệu 2 bảng để đối soát (0)';
  document.getElementById('agent3-status').textContent = hasScan
    ? `Log 100% (${fmtNum(AppState.scanRaw.length)} dòng) | ${fmtNum(r.duplicateAlerts.length)} Tag trùng & ${fmtNum(r.totalLocMismatch)} lệch BIN`
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
    ? `Nguồn cộng dồn (${AppState.scanSources.length} nguồn): ${AppState.scanFileName}`
    : 'Đã xóa dữ liệu cũ — Vui lòng nhập file Kiểm kê hoặc Quét PDA';
  const scanBadge = document.getElementById('scan-status-badge');
  scanBadge.textContent = hasScan ? `Đang hoạt động (${fmtNum(AppState.scanRaw.length)} dòng)` : 'Trống (0)';
  scanBadge.className = 'source-status-badge' + (hasScan ? '' : ' empty');
  document.getElementById('sm-scan-raw').textContent = fmtNum(AppState.scanRaw.length);
  document.getElementById('sm-scan-unique').textContent = fmtNum(r.uniqueScanTagsCount);
  const smScanTotalQtyEl = document.getElementById('sm-scan-total-qty');
  if (smScanTotalQtyEl) {
    smScanTotalQtyEl.textContent = fmtNum(r.totalScannedInclAllMatchedQty);
  }
  document.getElementById('sm-scan-dup').textContent = `${fmtNum(r.duplicateAlerts.length)} Tag (${fmtNum(r.totalExtraDuplicateScans)} lượt dư)`;

  // 6 Dynamic 3D KPI Cards
  const scannedPctQty = r.totalStockQty > 0 ? (r.totalScannedQty / r.totalStockQty) * 100 : 0;
  const missingPctQty = r.totalStockQty > 0 ? (r.totalMissingQty / r.totalStockQty) * 100 : 0;
  const scannedPctTag = r.totalStockTags > 0 ? (r.totalScannedTags / r.totalStockTags) * 100 : 0;
  const missingPctTag = r.totalStockTags > 0 ? (r.totalMissingTags / r.totalStockTags) * 100 : 0;
  const reconciledPctQty = r.totalStockQty > 0 ? (r.totalScannedInclOtherWhQty / r.totalStockQty) * 100 : 0;

  // Quick Glance Bar (Minimalist 1-Line Reconciliation Formula)
  const qgStockQty = document.getElementById('qg-stock-qty');
  if (qgStockQty) {
    qgStockQty.textContent = fmtNum(r.totalStockQty);
    document.getElementById('qg-stock-meta').textContent = `${fmtNum(r.totalStockTags)} Tag | ${fmtNum(r.uniqueItemCodesCount)} Mã hàng`;
    document.getElementById('qg-scan-0161-qty').textContent = fmtNum(r.totalScannedQty);
    document.getElementById('qg-scan-0161-meta').textContent = `${fmtNum(r.totalScannedTags)} Tag (${fmtPct(scannedPctQty)})`;
    document.getElementById('qg-other-wh-qty').textContent = `+${fmtNum(r.otherWhSamePfxQty)}`;
    document.getElementById('qg-other-wh-meta').textContent = `${fmtNum(r.otherWhSamePfxTags)} Tag (Kho 62, 60, 50)`;
    document.getElementById('qg-total-reconciled-qty').textContent = fmtNum(r.totalScannedInclOtherWhQty);
    document.getElementById('qg-total-reconciled-meta').textContent = `Đạt ${fmtPct(reconciledPctQty)} tồn kho`;
    document.getElementById('qg-net-diff-qty').textContent = fmtSignedNum(r.netDiffAfterOtherWhQty);
    document.getElementById('qg-net-diff-meta').textContent = `Thiếu thuần (01/61): -${fmtNum(r.totalMissingQty)} SL`;
  }

  updateNetworkAndMultiUserUI();

  document.getElementById('kpi-stock-qty').textContent = fmtNum(r.totalStockQty);
  document.getElementById('kpi-stock-tags').textContent = `${fmtNum(r.totalStockTags)} TagID`;
  document.getElementById('kpi-stock-items').textContent = `${fmtNum(r.uniqueItemCodesCount)} Mã hàng`;
  const allWhNote = document.getElementById('kpi-stock-allwh-note');
  if (allWhNote) {
    allWhNote.textContent = `Tổng tồn toàn hệ thống (3*,5*,7*): ${fmtNum(r.totalAllWhPositiveStockQty357)} SL`;
  }
  document.getElementById('bar-stock').style.width = r.totalStockQty > 0 ? '100%' : '0%';

  document.getElementById('kpi-scanned-qty').textContent = fmtNum(r.totalScannedQty);
  document.getElementById('kpi-scanned-tags').textContent = `${fmtNum(r.totalScannedTags)} Tag (${fmtPct(scannedPctTag)})`;
  document.getElementById('kpi-scanned-pct').textContent = fmtPct(scannedPctQty);
  const scannedWithOtherEl = document.getElementById('kpi-scanned-with-other');
  if (scannedWithOtherEl) {
    scannedWithOtherEl.textContent = `+ Kho khác (${fmtNum(r.otherWhSamePfxQty)}) → Tổng: ${fmtNum(r.totalScannedInclOtherWhQty)} SL`;
  }
  document.getElementById('bar-scanned').style.width = `${Math.min(100, scannedPctQty)}%`;

  document.getElementById('kpi-missing-qty').textContent = fmtNum(r.totalMissingQty);
  document.getElementById('kpi-missing-tags').textContent = `${fmtNum(r.totalMissingTags)} Tag (${fmtPct(missingPctTag)})`;
  document.getElementById('kpi-missing-pct').textContent = fmtPct(missingPctQty);
  const missingAfterOtherEl = document.getElementById('kpi-missing-after-other');
  if (missingAfterOtherEl) {
    const remainingMissing = Math.max(0, r.totalStockQty - r.totalScannedInclOtherWhQty);
    missingAfterOtherEl.textContent = `Trừ Tag kho khác còn thiếu: ${fmtNum(remainingMissing)} SL`;
  }
  document.getElementById('bar-missing').style.width = `${Math.min(100, missingPctQty)}%`;

  document.getElementById('kpi-dup-tags').textContent = fmtNum(r.duplicateAlerts.length);
  document.getElementById('kpi-dup-extra').textContent = `${fmtNum(r.totalExtraDuplicateScans)} lượt quét dư`;
  document.getElementById('kpi-dup-prevented').textContent = `Chặn +${fmtNum(r.totalPreventedInflatedQty)} SL ảo`;
  document.getElementById('bar-dup').style.width = r.duplicateAlerts.length > 0 ? '100%' : '0%';

  const locPct = r.totalScannedTags > 0 ? (r.totalLocMismatch / r.totalScannedTags) * 100 : 0;
  document.getElementById('kpi-loc-diff').textContent = fmtNum(r.totalLocMismatch);
  document.getElementById('kpi-loc-pct').textContent = `${fmtPct(locPct)} Tag đã quét`;
  document.getElementById('bar-loc').style.width = `${Math.min(100, locPct * 4)}%`;

  document.getElementById('kpi-out-tags').textContent = fmtNum(r.otherWhSamePfxQty);
  document.getElementById('kpi-out-other').textContent = `${fmtNum(r.otherWhSamePfxTags)} Tag kho khác (3*,5*,7*)`;
  document.getElementById('kpi-out-unknown').textContent = `${fmtNum(r.unmatchedUnknownCount)} chưa có sổ`;
  const outTotalNote = document.getElementById('kpi-out-total-note');
  if (outTotalNote) {
    outTotalNote.textContent = `Gồm cả ${fmtNum(r.otherPfxTags)} Tag mã 1*,9* (+${fmtNum(r.otherPfxQty)}): ${fmtNum(r.unmatchedOtherWhQty)} SL`;
  }
  document.getElementById('bar-out').style.width = r.unmatchedOtherWhQty > 0 ? '78%' : '0%';

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
    tbody.innerHTML = `<tr><td colspan="16" style="text-align:center; padding:24px; color:#94a3b8;">Không có dữ liệu tồn kho để đối soát (Hệ thống đang ở trạng thái 0).</td></tr>`;
    return;
  }

  let html = '';
  for (const row of r.matrixRows) {
    const tagPct = row.stockTags > 0 ? (row.scannedTags / row.stockTags) * 100 : 0;
    const totalScannedWithOther = row.scannedQty + row.otherWhQty;
    const netDiffWithOther = totalScannedWithOther - row.stockQty;
    const qtyPct = row.stockQty > 0 ? (row.scannedQty / row.stockQty) * 100 : 0;
    const qtyPctWithOther = row.stockQty > 0 ? (totalScannedWithOther / row.stockQty) * 100 : 0;
    const badgeClass = qtyPctWithOther >= 95 ? 'status-ok' : (qtyPctWithOther >= 85 ? 'status-dup' : 'status-miss');
    const badgeText = qtyPctWithOther >= 95 ? 'Rất tốt (≥95%)' : (qtyPctWithOther >= 85 ? 'Khá (Cần rà soát)' : 'Cần kiểm bổ sung');

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
        <td class="num-col" style="color:#c084fc;"><strong>${row.otherWhTags > 0 ? '+' + fmtNum(row.otherWhTags) : '0'}</strong></td>
        <td class="num-col" style="color:#c084fc;"><strong>${row.otherWhQty > 0 ? '+' + fmtNum(row.otherWhQty) : '0'}</strong></td>
        <td class="num-col" style="color:#38bdf8;"><strong>${fmtNum(totalScannedWithOther)}</strong></td>
        <td class="num-col" style="color:${netDiffWithOther >= 0 ? '#34d399' : '#fda4af'};"><strong>${fmtSignedNum(netDiffWithOther)}</strong></td>
        <td class="num-col" title="Tỷ lệ thuần Kho ${row.wh}: ${fmtPct(qtyPct)}"><strong>${fmtPct(qtyPctWithOther)}</strong></td>
        <td><span class="status-pill ${badgeClass}">${badgeText}</span></td>
      </tr>
    `;
  }

  const totalTagPct = r.totalStockTags > 0 ? (r.totalScannedTags / r.totalStockTags) * 100 : 0;
  const totalQtyPct = r.totalStockQty > 0 ? (r.totalScannedQty / r.totalStockQty) * 100 : 0;
  const totalQtyPctWithOther = r.totalStockQty > 0 ? (r.totalScannedInclOtherWhQty / r.totalStockQty) * 100 : 0;
  const totalQtyPctWithAll = r.totalStockQty > 0 ? (r.totalScannedInclAllMatchedQty / r.totalStockQty) * 100 : 0;

  html += `
    <tr style="background: rgba(56, 189, 248, 0.14); font-weight: 800;">
      <td colspan="2">1. TỔNG PHẠM VI (KHO 01 & 61 | MÃ 3*, 5*, 7*)</td>
      <td class="num-col">${fmtNum(r.uniqueItemCodesCount)}</td>
      <td class="num-col">${fmtNum(r.totalStockTags)}</td>
      <td class="num-col" style="color:#34d399;">${fmtNum(r.totalScannedTags)}</td>
      <td class="num-col" style="color:#fb7185;">${fmtNum(r.totalMissingTags)}</td>
      <td class="num-col">${fmtPct(totalTagPct)}</td>
      <td class="num-col">${fmtNum(r.totalStockQty)}</td>
      <td class="num-col" style="color:#34d399;">${fmtNum(r.totalScannedQty)}</td>
      <td class="num-col" style="color:#fb7185;">${fmtNum(r.totalMissingQty)}</td>
      <td class="num-col" style="color:#c084fc;">+${fmtNum(r.otherWhSamePfxTags)}</td>
      <td class="num-col" style="color:#c084fc;">+${fmtNum(r.otherWhSamePfxQty)}</td>
      <td class="num-col" style="color:#38bdf8;">${fmtNum(r.totalScannedInclOtherWhQty)}</td>
      <td class="num-col" style="color:${r.netDiffAfterOtherWhQty >= 0 ? '#34d399' : '#fda4af'};">${fmtSignedNum(r.netDiffAfterOtherWhQty)}</td>
      <td class="num-col">${fmtPct(totalQtyPctWithOther)} <span style="font-size:0.72rem; color:#94a3b8;">(Gốc: ${fmtPct(totalQtyPct)})</span></td>
      <td><span class="status-pill status-ok">Đã cộng đối soát Kho khác</span></td>
    </tr>
    <tr style="background: rgba(192, 132, 252, 0.12); font-weight: 700;">
      <td colspan="2">2. (+) TAG QUÉT ĐƯỢC KHÁC NHÓM MÃ (MÃ 1*, 9* TẠI KHO 01, 61)</td>
      <td class="num-col">-</td>
      <td class="num-col">-</td>
      <td class="num-col">-</td>
      <td class="num-col">-</td>
      <td class="num-col">-</td>
      <td class="num-col">-</td>
      <td class="num-col">-</td>
      <td class="num-col">-</td>
      <td class="num-col" style="color:#c084fc;">+${fmtNum(r.otherPfxTags)}</td>
      <td class="num-col" style="color:#c084fc;">+${fmtNum(r.otherPfxQty)}</td>
      <td class="num-col" style="color:#38bdf8;">${fmtNum(r.totalScannedInclAllMatchedQty)}</td>
      <td class="num-col" style="color:${r.netDiffAfterAllMatchedQty >= 0 ? '#34d399' : '#fda4af'};">${fmtSignedNum(r.netDiffAfterAllMatchedQty)}</td>
      <td class="num-col">${fmtPct(totalQtyPctWithAll)}</td>
      <td><span class="status-pill status-warn">Tổng ngoại lệ có sổ: +${fmtNum(r.unmatchedOtherWhQty)} SL (${fmtNum(r.unmatchedOtherWhCount)} Tag)</span></td>
    </tr>
  `;
  tbody.innerHTML = html;
}

function renderActiveTables() {
  const r = AppState.reconciled;
  if (!r) return;
  const q = AppState.searchQuery.toLowerCase().trim();
  const sf = AppState.statusFilter;

  // 1. Render Tab Items (Full 100% items, no slice truncation)
  const filteredItems = r.itemSummaries.filter((item) => {
    if (sf === 'MISSING' && item.missingTags === 0) return false;
    if (sf === 'COMPLETE' && (item.missingTags > 0 || item.stockTags === 0)) return false;
    if (sf === 'OTHER_WH' && item.otherWhTags === 0) return false;
    if (sf === 'DUP' && item.dupTags === 0) return false;
    if (sf === 'LOC_DIFF' && item.locDiffTags === 0) return false;
    if (q) {
      const hay = `${item.wh} ${item.code} ${item.binsStr} ${item.scanLocsStr} ${item.otherWhsStr}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const tbodyItems = document.getElementById('tbody-items');
  if (filteredItems.length === 0) {
    tbodyItems.innerHTML = `<tr><td colspan="18" style="text-align:center; padding:24px; color:#94a3b8;">Không có mã hàng nào khớp bộ lọc.</td></tr>`;
  } else {
    tbodyItems.innerHTML = filteredItems.map((it, i) => {
      let stPill = `<span class="status-pill status-ok">Đủ 100%</span>`;
      if (it.stockTags === 0 && it.otherWhTags > 0) {
        stPill = `<span class="status-pill status-warn">Tồn ở ${it.otherWhsStr}</span>`;
      } else if (it.missingTags > 0 && it.otherWhTags > 0) {
        stPill = `<span class="status-pill status-warn">Thiếu ${fmtNum(it.missingTags)} Tag (Có +${fmtNum(it.otherWhTags)} Tag ${it.otherWhsStr})</span>`;
      } else if (it.missingTags > 0) {
        stPill = `<span class="status-pill status-miss">Thiếu ${fmtNum(it.missingTags)} Tag</span>`;
      } else if (it.otherWhTags > 0) {
        stPill = `<span class="status-pill status-warn">Đủ + Dư ${fmtNum(it.otherWhTags)} Tag (${it.otherWhsStr})</span>`;
      } else if (it.dupTags > 0) {
        stPill = `<span class="status-pill status-dup">Có Tag trùng</span>`;
      }
      const diffColor = it.netDiffWithOtherWh >= 0 ? (it.netDiffWithOtherWh > 0 ? '#c084fc' : '#34d399') : '#fb7185';
      return `
        <tr>
          <td>${i + 1}</td>
          <td><strong>Kho ${it.wh}</strong></td>
          <td style="font-family:'JetBrains Mono',monospace; font-weight:700; color:#7dd3fc;">${it.code}</td>
          <td>${it.prefix}</td>
          <td class="num-col">${fmtNum(it.stockTags)}</td>
          <td class="num-col" style="color:#34d399;">${fmtNum(it.scannedTags)}</td>
          <td class="num-col" style="color:#fb7185;">${fmtNum(it.missingTags)}</td>
          <td class="num-col" title="Tổng tồn toàn hệ thống: ${fmtNum(it.allWhStockQty)}">${fmtNum(it.stockQty)}</td>
          <td class="num-col" style="color:#34d399;"><strong>${fmtNum(it.scannedQty)}</strong></td>
          <td class="num-col" style="color:#fb7185;"><strong>${fmtNum(it.missingQty)}</strong></td>
          <td class="num-col" style="color:#c084fc;">${it.otherWhTags > 0 ? `<strong>+${fmtNum(it.otherWhTags)}</strong> (${it.otherWhsStr})` : '0'}</td>
          <td class="num-col" style="color:#c084fc;"><strong>${it.otherWhQty > 0 ? '+' + fmtNum(it.otherWhQty) : '0'}</strong></td>
          <td class="num-col" style="color:#38bdf8;"><strong>${fmtNum(it.totalScannedWithOtherWh)}</strong></td>
          <td class="num-col" style="color:${diffColor};"><strong>${fmtSignedNum(it.netDiffWithOtherWh)}</strong></td>
          <td class="num-col">${fmtPct(it.pctQtyWithOtherWh)}</td>
          <td style="max-width:170px; overflow:hidden; text-overflow:ellipsis;" title="${it.binsStr}">${it.binsStr}</td>
          <td style="max-width:170px; overflow:hidden; text-overflow:ellipsis;" title="${it.scanLocsStr}">${it.scanLocsStr}</td>
          <td>${stPill}</td>
        </tr>
      `;
    }).join('');
  }

  // 2. Render Tab Details (By TagID / Batch - Full 100% tags, no slice truncation)
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
    tbodyDetails.innerHTML = filteredDetails.map((td, i) => {
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

  // 4. Render Tab 4: Cross-Warehouse Reconciliation & Unmatched Tags
  renderOtherWarehouseReconciliationTab(r, q);

  // 5. Render Tab PDA Log (Full 100% Log - NO ROW LIMIT + MULTI-USER + OFFLINE SYNC STATUS!)
  const tbodyPdaLog = document.getElementById('tbody-pda-log');
  const logTotalIndicator = document.getElementById('pda-log-total-indicator');
  if (AppState.scanRaw.length === 0) {
    tbodyPdaLog.innerHTML = `<tr><td colspan="10" style="text-align:center; padding:24px; color:#94a3b8;">Bảng dữ liệu ghi log quét PDA đang trống (0 dòng).</td></tr>`;
    if (logTotalIndicator) logTotalIndicator.textContent = 'Đang chứa: 0 / 0 dòng log (Không giới hạn)';
  } else {
    const rowsHtml = [];
    for (let i = 0; i < AppState.scanRaw.length; i++) {
      const s = AppState.scanRaw[i];
      if (!s.scanId) s.scanId = generateScanId(s.user || 'U', 'LOG');
      if (q && !`${s.tag} ${s.loc} ${s.user} ${s.time} ${s.source || ''} ${s.scanId}`.toLowerCase().includes(q)) continue;
      const st = r.filteredStockByBatch.get(s.tag);
      const otherStList = !st ? r.otherStockByBatch.get(s.tag) : null;
      const otherSt = (otherStList && otherStList.length > 0) ? otherStList[0] : null;
      const scansForTag = r.scanByTag.get(s.tag) || [];
      const qty = (Number(s.manualQty) > 0) ? Number(s.manualQty) : (st ? st.qty : (otherSt ? otherSt.qty : 0));

      let badge = `<span class="status-pill status-ok">Khớp Kho ${st ? st.wh : ''}</span>`;
      if (!st && otherSt) {
        badge = `<span class="status-pill status-warn">Đang ở Kho ${otherSt.wh}</span>`;
      } else if (!st && !otherSt) {
        badge = `<span class="status-pill status-miss">Chưa có sổ</span>`;
      } else if (scansForTag.length > 1) {
        badge = `<span class="status-pill status-dup">Trùng (${scansForTag.length}x)</span>`;
      }

      const syncBadge = (s.offlineQueued || s.syncStatus === 'OFFLINE_PENDING')
        ? `<span class="status-pill status-dup" title="Quét khi Offline - Chờ đồng bộ">📴 Offline chờ đồng bộ</span>`
        : `<span class="badge-scope">${s.source || 'File kiểm kê'}${s.syncedAt ? ' ✓ Đã đồng bộ' : ''}</span>`;

      const matchedInfo = st
        ? `${st.code} (Kho ${st.wh})`
        : (otherSt ? `${otherSt.code} (Kho ${otherSt.wh})` : '-');

      const safeId = String(s.scanId).replace(/'/g, "\\'");

      rowsHtml.push(`
        <tr class="${s.isNew ? 'new-scan-highlight' : ''}">
          <td><strong>#${i + 1}</strong> ${s.isNew ? '🆕' : ''}</td>
          <td>
            <button class="row-action-btn" onclick="openPdaAndEditRowById('${safeId}', ${i})" title="Sửa dòng này (An toàn đa người dùng)">✏️ Sửa</button>
            <button class="row-action-btn del" onclick="deletePdaRowById('${safeId}', ${i})" title="Xóa dòng này (An toàn đa người dùng)">🗑️ Xóa</button>
          </td>
          <td style="font-family:'JetBrains Mono',monospace; font-weight:700; color:#7dd3fc;">${s.tag}</td>
          <td>${s.loc || '-'}</td>
          <td><strong>${s.user || '-'}</strong></td>
          <td class="num-col"><strong>${fmtNum(qty)}</strong></td>
          <td style="font-family:'JetBrains Mono',monospace;">${matchedInfo}</td>
          <td>${s.time || '-'}</td>
          <td>${syncBadge}</td>
          <td>${badge}</td>
        </tr>
      `);
    }
    tbodyPdaLog.innerHTML = rowsHtml.join('');
    if (logTotalIndicator) {
      const pendingOffline = getPendingOfflineScansCount();
      logTotalIndicator.textContent = `Hiển thị: ${fmtNum(rowsHtml.length)} / ${fmtNum(AppState.scanRaw.length)} dòng log (100% không giới hạn${pendingOffline > 0 ? ` | 📴 ${pendingOffline} Offline chờ đồng bộ` : ''})`;
    }
  }

  document.getElementById('table-showing-info').textContent =
    `Hiển thị 100%: ${fmtNum(filteredItems.length)} Mã hàng | ${fmtNum(filteredDetails.length)} TagID | ${fmtNum(AppState.scanRaw.length)} Dòng Log`;
}

function renderOtherWarehouseReconciliationTab(r, q) {
  // Top Summary Cards inside Tab 4
  const reconBox = document.getElementById('other-wh-reconciliation-box');
  if (reconBox) {
    reconBox.innerHTML = `
      <div class="other-wh-summary-grid">
        <div class="other-wh-summary-card">
          <span class="ow-title">1. SL Quét Được Nhưng Ở Kho Khác (3*, 5*, 7*)</span>
          <strong class="ow-val">+${fmtNum(r.otherWhSamePfxQty)} SL</strong>
          <p class="ow-sub">${fmtNum(r.otherWhSamePfxTags)} TagID thuộc Kho 62, 60, 50 trên sổ tồn</p>
        </div>
        <div class="other-wh-summary-card">
          <span class="ow-title">2. SL Quét Được Khác Nhóm Mã (1*, 9*)</span>
          <strong class="ow-val" style="color:#f59e0b;">+${fmtNum(r.otherPfxQty)} SL</strong>
          <p class="ow-sub">${fmtNum(r.otherPfxTags)} TagID (Tổng cộng có sổ: ${fmtNum(r.unmatchedOtherWhCount)} Tag = +${fmtNum(r.unmatchedOtherWhQty)} SL)</p>
        </div>
        <div class="other-wh-summary-card">
          <span class="ow-title">3. Tổng SL Kiểm Khi Cộng Tag Kho Khác</span>
          <strong class="ow-val" style="color:#34d399;">${fmtNum(r.totalScannedInclOtherWhQty)} SL</strong>
          <p class="ow-sub">Kho 01 & 61 (${fmtNum(r.totalScannedQty)}) + Kho khác (${fmtNum(r.otherWhSamePfxQty)})</p>
        </div>
        <div class="other-wh-summary-card">
          <span class="ow-title">4. Đối Soát Với Tổng Tồn Kho (${fmtNum(r.totalStockQty)})</span>
          <strong class="ow-val" style="color:#fb7185;">${fmtSignedNum(r.netDiffAfterOtherWhQty)} SL</strong>
          <p class="ow-sub">Giảm chênh lệch thiếu từ ${fmtNum(r.totalMissingQty)} xuống ${fmtNum(Math.max(0, -r.netDiffAfterOtherWhQty))} SL</p>
        </div>
      </div>
    `;
  }

  // Table 4.1: Summary by Other Warehouse
  const tbodyWhSum = document.getElementById('tbody-other-wh-summary');
  if (tbodyWhSum) {
    if (r.otherWhSummaryRows.length === 0) {
      tbodyWhSum.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:18px; color:#94a3b8;">Không có Tag quét ở kho khác.</td></tr>`;
    } else {
      let sumTags = 0, sumQty = 0, sum0161Stock = 0, sum0161Scan = 0, sumAllWh = 0;
      const rowsHtml = r.otherWhSummaryRows.map((row) => {
        sumTags += row.scannedTags;
        sumQty += row.scannedQty;
        sum0161Stock += row.stock0161Qty;
        sum0161Scan += row.scanned0161Qty;
        sumAllWh += row.allWhStockQty;
        return `
          <tr>
            <td><strong>Kho ${row.wh}</strong></td>
            <td><span class="status-pill ${row.isTargetPfx ? 'status-warn' : 'status-dup'}">${row.categoryLabel}</span></td>
            <td class="num-col">${fmtNum(row.codesCount)}</td>
            <td class="num-col" style="color:#c084fc;"><strong>${fmtNum(row.scannedTags)}</strong></td>
            <td class="num-col" style="color:#c084fc;"><strong>+${fmtNum(row.scannedQty)}</strong></td>
            <td class="num-col">${fmtNum(row.stock0161Qty)}</td>
            <td class="num-col" style="color:#34d399;">${fmtNum(row.scanned0161Qty)}</td>
            <td class="num-col" style="color:#38bdf8;"><strong>${fmtNum(row.totalScannedCombined)}</strong></td>
            <td class="num-col">${fmtNum(row.allWhStockQty)}</td>
          </tr>
        `;
      }).join('');

      tbodyWhSum.innerHTML = rowsHtml + `
        <tr style="background: rgba(192, 132, 252, 0.14); font-weight: 800;">
          <td colspan="2">TỔNG CỘNG TAG QUÉT ĐƯỢC Ở KHO / NHÓM MÃ KHÁC</td>
          <td class="num-col">${fmtNum(r.otherWhItemRows.length)} mã</td>
          <td class="num-col" style="color:#c084fc;">${fmtNum(sumTags)} Tag</td>
          <td class="num-col" style="color:#c084fc;">+${fmtNum(sumQty)} SL</td>
          <td class="num-col">${fmtNum(sum0161Stock)}</td>
          <td class="num-col" style="color:#34d399;">${fmtNum(sum0161Scan)}</td>
          <td class="num-col" style="color:#38bdf8;">${fmtNum(sum0161Scan + sumQty)}</td>
          <td class="num-col">${fmtNum(sumAllWh)}</td>
        </tr>
      `;
    }
  }

  // Table 4.2: Summary by Item Code with Other-WH Scanned Tags vs Total Stock
  const tbodyOtherItems = document.getElementById('tbody-other-wh-items');
  const badgeOtherItems = document.getElementById('badge-other-wh-items-count');
  const filteredOtherItems = r.otherWhItemRows.filter((it) => {
    if (!q) return true;
    const tagStr = it.tagList.map((t) => t.tag).join(' ');
    return `${it.code} ${it.otherWhsStr} ${tagStr}`.toLowerCase().includes(q);
  });
  if (badgeOtherItems) badgeOtherItems.textContent = `${fmtNum(filteredOtherItems.length)} mã hàng`;

  if (tbodyOtherItems) {
    if (filteredOtherItems.length === 0) {
      tbodyOtherItems.innerHTML = `<tr><td colspan="14" style="text-align:center; padding:18px; color:#94a3b8;">Không có mã hàng nào có Tag quét ở kho khác.</td></tr>`;
    } else {
      tbodyOtherItems.innerHTML = filteredOtherItems.map((it, i) => {
        const diff0161Color = it.diffVs0161Stock >= 0 ? '#34d399' : '#fb7185';
        const diffAllColor = it.diffVsAllWhStock >= 0 ? '#34d399' : '#fda4af';
        const tagDetailsStr = it.tagList.map((t) => `${t.tag} (Kho ${t.wh}: ${fmtNum(t.qty)} SL @ Quét: ${t.scanLoc})`).join(' | ');
        return `
          <tr>
            <td>${i + 1}</td>
            <td style="font-family:'JetBrains Mono',monospace; font-weight:700; color:#7dd3fc;">${it.code}</td>
            <td>${it.prefix}</td>
            <td><span class="status-pill status-warn">${it.otherWhsStr}</span></td>
            <td class="num-col" style="color:#c084fc;"><strong>+${fmtNum(it.otherWhTags)}</strong></td>
            <td class="num-col" style="color:#c084fc;"><strong>+${fmtNum(it.otherWhQty)}</strong></td>
            <td class="num-col">${fmtNum(it.stock0161Qty)}</td>
            <td class="num-col" style="color:#34d399;">${fmtNum(it.scanned0161Qty)}</td>
            <td class="num-col" style="color:#fb7185;">${fmtNum(it.missing0161Qty)}</td>
            <td class="num-col" style="color:#38bdf8;"><strong>${fmtNum(it.totalScannedInclOtherWh)}</strong></td>
            <td class="num-col" style="color:${diff0161Color};"><strong>${fmtSignedNum(it.diffVs0161Stock)}</strong></td>
            <td class="num-col"><strong>${fmtNum(it.allWhStockQty)}</strong></td>
            <td class="num-col" style="color:${diffAllColor};"><strong>${fmtSignedNum(it.diffVsAllWhStock)}</strong></td>
            <td style="white-space:normal; min-width:300px; font-size:0.76rem;">${tagDetailsStr}</td>
          </tr>
        `;
      }).join('');
    }
  }

  // Table 4.3: Individual Unmatched / Other-WH Tag Details
  const tbodyUnmatched = document.getElementById('tbody-unmatched');
  const badgeUnmCount = document.getElementById('badge-unmatched-tags-count');
  const unmFiltered = r.unmatchedAlerts.filter((u) => {
    if (!q) return true;
    return `${u.tag} ${u.wh} ${u.code} ${u.loc} ${u.user} ${u.info}`.toLowerCase().includes(q);
  });
  if (badgeUnmCount) badgeUnmCount.textContent = `${fmtNum(unmFiltered.length)} TagID`;

  if (unmFiltered.length === 0) {
    tbodyUnmatched.innerHTML = `<tr><td colspan="11" style="text-align:center; padding:24px; color:#94a3b8;">Không có TagID ngoài phạm vi.</td></tr>`;
  } else {
    tbodyUnmatched.innerHTML = unmFiltered.map((u, i) => {
      const pill = u.type === 'OTHER_WH'
        ? `<span class="status-pill status-warn">${u.typeLabel}</span>`
        : (u.type === 'OTHER_PREFIX'
          ? `<span class="status-pill status-dup">${u.typeLabel}</span>`
          : `<span class="status-pill status-miss">${u.typeLabel}</span>`);
      return `
        <tr>
          <td>${i + 1}</td>
          <td style="font-family:'JetBrains Mono',monospace; font-weight:700; color:${u.type === 'NOT_IN_STOCK' ? '#f43f5e' : '#c084fc'};">${u.tag}</td>
          <td><strong>${u.wh !== '-' ? 'Kho ' + u.wh : '-'}</strong></td>
          <td style="font-family:'JetBrains Mono',monospace; font-weight:700;">${u.code}</td>
          <td class="num-col" style="color:#c084fc;"><strong>${fmtNum(u.qty)}</strong></td>
          <td>${u.bin || '-'}</td>
          <td>${u.loc || '-'}</td>
          <td>${u.user || '-'}</td>
          <td>${u.time || '-'}</td>
          <td>${pill}</td>
          <td>${u.info}</td>
        </tr>
      `;
    }).join('');
  }
}

/* ==========================================================================
   ZEBRA PDA COMPACT SCANNER MODAL (MULTI-USER CONCURRENT + OFFLINE/ONLINE SYNC)
   ========================================================================== */
function updateNetworkAndMultiUserUI() {
  const online = isEffectiveOnline();
  const pendingOffline = getPendingOfflineScansCount();
  const r = AppState.reconciled;
  const activeUsersCount = r && r.userStats ? r.userStats.length : 1;

  const headerNet = document.getElementById('header-net-status');
  if (headerNet) {
    headerNet.textContent = online
      ? `🟢 ONLINE${pendingOffline > 0 ? ` (${pendingOffline} chờ đồng bộ)` : ' (Đã đồng bộ)'}`
      : `📴 OFFLINE (${pendingOffline} quét chờ đồng bộ)`;
    headerNet.style.borderColor = online ? 'rgba(16, 185, 129, 0.5)' : 'rgba(245, 158, 11, 0.7)';
    headerNet.style.color = online ? '#34d399' : '#fbbf24';
  }

  const headerMulti = document.getElementById('header-multiuser-badge');
  if (headerMulti) {
    headerMulti.textContent = `👥 Đa User: ${activeUsersCount} nhân sự`;
  }

  const pdaNetBtn = document.getElementById('pda-net-toggle-btn');
  if (pdaNetBtn) {
    pdaNetBtn.textContent = online ? '🟢 ONLINE' : '📴 OFFLINE';
    pdaNetBtn.classList.toggle('online', online);
    pdaNetBtn.classList.toggle('offline', !online);
  }

  const pdaOfflineCountEl = document.getElementById('pda-offline-count');
  if (pdaOfflineCountEl) {
    pdaOfflineCountEl.textContent = fmtNum(pendingOffline);
  }

  const s2OfflineCountEl = document.getElementById('source2-offline-count');
  if (s2OfflineCountEl) {
    s2OfflineCountEl.textContent = fmtNum(pendingOffline);
  }

  const pdaSyncText = document.getElementById('pda-sync-status-text');
  if (pdaSyncText) {
    pdaSyncText.innerHTML = online
      ? `👥 Đa User (${activeUsersCount}) | Offline chờ: <strong id="pda-offline-count" style="color:${pendingOffline > 0 ? '#fbbf24' : '#34d399'};">${fmtNum(pendingOffline)}</strong>`
      : `📴 <strong>ĐANG OFFLINE</strong> | Đã lưu đệm: <strong id="pda-offline-count" style="color:#fbbf24;">${fmtNum(pendingOffline)}</strong> dòng`;
  }
}

function toggleOfflineMode(forceOffline) {
  if (typeof forceOffline === 'boolean') {
    AppState.manualOfflineMode = forceOffline;
  } else {
    AppState.manualOfflineMode = !AppState.manualOfflineMode;
  }
  updateNetworkAndMultiUserUI();
  const box = document.getElementById('pda-live-lookup');
  if (!isEffectiveOnline()) {
    if (box) {
      box.style.borderColor = '#f59e0b';
      box.innerHTML = '📴 Đang ở chế độ <strong>QUÉT OFFLINE</strong>: Mọi lượt quét vẫn ghi nhận đầy đủ vào bộ nhớ đệm PDA!';
    }
  } else {
    // Auto-sync when switching back to Online if there are pending offline scans
    const pending = getPendingOfflineScansCount();
    if (pending > 0) {
      syncOfflineScansNow({ silent: false });
    } else if (box) {
      box.style.borderColor = '#10b981';
      box.innerHTML = '🟢 Đã kết nối <strong>ONLINE</strong>: Dữ liệu đồng bộ & đối soát tồn kho trực tiếp!';
    }
  }
}

function syncOfflineScansNow(options = {}) {
  // Switch to Online so offline activity can synchronize
  AppState.manualOfflineMode = false;
  AppState.isOnline = true;

  // Merge any external or queued offline scans from localStorage
  mergeExternalMultiUserScans(false);

  const nowStr = getNowTimeStr();
  let syncedCount = 0;
  const usersInvolved = new Set();

  for (const row of AppState.scanRaw) {
    if (row.offlineQueued || row.syncStatus === 'OFFLINE_PENDING') {
      row.offlineQueued = false;
      row.syncStatus = 'SYNCED';
      row.syncedAt = nowStr;
      if (row.source && row.source.includes('Offline')) {
        row.source = 'Máy quét PDA (Đã đồng bộ Online)';
      }
      syncedCount++;
      if (row.user) usersInvolved.add(row.user);
    }
  }

  let syncedActivities = 0;
  for (const act of AppState.offlineActivityLog) {
    if (!act.synced) {
      act.synced = true;
      act.syncedAt = nowStr;
      syncedActivities++;
      if (act.user) usersInvolved.add(act.user);
    }
  }

  // Clear pending offline queue and update shared storage
  safeWriteStorageArray(STORAGE_KEYS.OFFLINE_QUEUE, []);
  const shared = safeReadStorageArray(STORAGE_KEYS.SHARED_SCANS).map((s) => ({
    ...s,
    offlineQueued: false,
    syncStatus: 'SYNCED',
    syncedAt: s.syncedAt || nowStr
  }));
  safeWriteStorageArray(STORAGE_KEYS.SHARED_SCANS, shared);
  safeWriteStorageArray(STORAGE_KEYS.ACTIVITY_LOG, AppState.offlineActivityLog.slice(0, 5000));

  AppState.syncHistory.unshift({
    syncTime: nowStr,
    syncedScansCount: syncedCount,
    syncedActivitiesCount: syncedActivities,
    users: Array.from(usersInvolved)
  });

  refreshScanFileNameLabel();
  runMultiAgentReconciliation();
  updateNetworkAndMultiUserUI();

  const box = document.getElementById('pda-live-lookup');
  if (box && !options.silent) {
    box.style.borderColor = '#10b981';
    box.innerHTML = `🔄 Đã Online & đồng bộ <strong>${fmtNum(syncedCount)}</strong> lượt quét Offline (${fmtNum(syncedActivities)} hoạt động) → Đối soát tồn kho chuẩn 100%!`;
  }

  return { syncedCount, syncedActivities, syncTime: nowStr };
}

function syncAndExportPdaExcel() {
  const syncRes = syncOfflineScansNow({ silent: false });
  exportPdaScansOnly();
  const box = document.getElementById('pda-live-lookup');
  if (box) {
    box.style.borderColor = '#10b981';
    box.innerHTML = `💾 Đã Online đồng bộ (${fmtNum(syncRes.syncedCount)} dòng Offline) & Xuất File Excel PDA thành công!`;
  }
}

function syncAndExportFullExcel() {
  syncOfflineScansNow({ silent: false });
  exportFullExcelReport();
}

function openPdaModal() {
  document.getElementById('pda-modal-overlay').classList.add('open');
  updateNetworkAndMultiUserUI();
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

function openPdaAndEditRowById(scanId, fallbackIdx) {
  openPdaModal();
  editPdaRowById(scanId, fallbackIdx);
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
    box.innerHTML = isEffectiveOnline()
      ? 'Sẵn sàng quét TagID (Hỗ trợ đa User & Offline)...'
      : '📴 Chế độ OFFLINE: Sẵn sàng quét TagID vào bộ nhớ đệm...';
    box.style.borderColor = 'rgba(56, 189, 248, 0.25)';
    return;
  }

  const isEditing = AppState.editingScanId !== null || AppState.editingScanIndex >= 0;
  const existingScans = r.scanByTag.get(tag) || [];
  const st = r.filteredStockByBatch.get(tag);
  const otherSt = r.otherStockByBatch.get(tag);

  if (st) {
    if (!isEditing) {
      qtyInput.value = st.qty;
    }
    if (existingScans.length > 0 && !isEditing) {
      box.style.borderColor = '#f59e0b';
      box.innerHTML = `⚠️ TRÙNG TAG (${existingScans.length}x) | Mã ${st.code} | SL: ${fmtNum(st.qty)}`;
    } else {
      box.style.borderColor = '#10b981';
      box.innerHTML = `✅ Mã: <strong>${st.code}</strong> (Kho ${st.wh}) | BIN: ${st.bin || '-'} | SL: <strong style="color:#34d399;">${fmtNum(st.qty)}</strong>`;
    }
  } else if (otherSt && otherSt.length > 0) {
    const o = otherSt[0];
    if (!isEditing) qtyInput.value = o.qty;
    box.style.borderColor = '#a855f7';
    box.innerHTML = `🏢 Đang ở Kho ${o.wh} | Mã ${o.code} | SL: ${fmtNum(o.qty)} (Tự động đối soát kho khác)`;
  } else {
    box.style.borderColor = '#f43f5e';
    box.innerHTML = `❓ Tag chưa có trên sổ tồn — Nhập Qty thủ công`;
  }
}

function refreshScanFileNameLabel() {
  if (AppState.scanRaw.length === 0) {
    AppState.scanFileName = 'Đã xóa (0 dòng)';
    return;
  }
  const pendingOffline = getPendingOfflineScansCount();
  const srcList = AppState.scanSources.length > 0 ? AppState.scanSources.join(' + ') : 'Dữ liệu quét';
  AppState.scanFileName = `${srcList} (Tổng cộng dồn: ${fmtNum(AppState.scanRaw.length)} dòng${pendingOffline > 0 ? ` | 📴 ${pendingOffline} Offline` : ''})`;
}

// Atomic, multi-user safe scan insertion/update function
function performAtomicScanSubmission({ user, loc, tag, manualQty, isOfflineOverride, useActiveEditState = false, targetEditScanId = null }) {
  const cleanUser = String(user || '').trim() || 'USER';
  const cleanLoc = String(loc || '').trim() || '-';
  const cleanTag = String(tag || '').trim();
  const cleanQty = Number(manualQty) || 0;
  if (!cleanTag) return null;

  const timeStr = getNowTimeStr();
  const offlineMode = typeof isOfflineOverride === 'boolean' ? isOfflineOverride : !isEffectiveOnline();

  // Check if editing an existing row by immutable scanId (only when requested by the editing user)
  const effectiveEditId = targetEditScanId || (useActiveEditState ? AppState.editingScanId : null);
  const effectiveEditIdx = useActiveEditState ? AppState.editingScanIndex : -1;
  const editIdx = (effectiveEditId !== null || effectiveEditIdx >= 0)
    ? findScanIndexById(effectiveEditId, effectiveEditIdx)
    : -1;

  if ((effectiveEditId !== null || effectiveEditIdx >= 0) && editIdx >= 0 && editIdx < AppState.scanRaw.length) {
    const row = AppState.scanRaw[editIdx];
    row.user = cleanUser;
    row.loc = cleanLoc;
    row.tag = cleanTag;
    row.manualQty = cleanQty;
    row.time = timeStr;
    row.isNew = true;
    if (offlineMode) {
      row.offlineQueued = true;
      row.syncStatus = 'OFFLINE_PENDING';
    }

    recordPdaActivity('EDIT', row);
    persistMultiUserAndOfflineScan(row, 'UPSERT');
    cancelPdaEditMode();
    refreshScanFileNameLabel();
    runMultiAgentReconciliation();
    return { mode: 'EDIT', record: row };
  }

  // Create collision-free scan record for concurrent multi-user scanning
  const scanId = generateScanId(cleanUser, 'PDA');
  const newScanRecord = {
    scanId,
    stt: `PDA-${AppState.scanRaw.length + 1}-${cleanUser}`,
    tag: cleanTag,
    loc: cleanLoc,
    user: cleanUser,
    time: timeStr,
    manualQty: cleanQty,
    isNew: true,
    offlineQueued: offlineMode,
    syncStatus: offlineMode ? 'OFFLINE_PENDING' : 'SYNCED',
    syncedAt: offlineMode ? null : timeStr,
    source: offlineMode ? 'Máy quét PDA (Offline)' : 'Máy quét PDA'
  };

  AppState.scanRaw.unshift(newScanRecord);
  // Keep any active edit index synchronized if another user inserted at index 0 concurrently
  if (AppState.editingScanId) {
    AppState.editingScanIndex = findScanIndexById(AppState.editingScanId, AppState.editingScanIndex);
  }
  if (!AppState.scanSources.includes('Máy quét PDA')) {
    AppState.scanSources.push('Máy quét PDA');
  }
  recordPdaActivity(offlineMode ? 'SCAN_OFFLINE' : 'SCAN_ONLINE', newScanRecord);
  persistMultiUserAndOfflineScan(newScanRecord, 'UPSERT');
  refreshScanFileNameLabel();
  runMultiAgentReconciliation();

  return { mode: 'INSERT', record: newScanRecord };
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

  const res = performAtomicScanSubmission({ user, loc, tag, manualQty, useActiveEditState: true });
  if (!res) return;

  const box = document.getElementById('pda-live-lookup');
  if (res.mode === 'EDIT') {
    if (box) {
      box.style.borderColor = '#10b981';
      box.innerHTML = `✅ Đã lưu sửa dòng Tag <strong>${tag}</strong> (${user}) & cập nhật đối soát!`;
    }
    tagEl.focus();
    return;
  }

  tagEl.value = '';
  qtyEl.value = '';
  if (box) {
    if (res.record.offlineQueued) {
      box.style.borderColor = '#f59e0b';
      box.innerHTML = `📴 [OFFLINE] Đã lưu đệm & ghi Log: <strong>${tag}</strong> (${user} @ ${loc}) — Bấm Đồng bộ khi Online`;
    } else {
      box.style.borderColor = '#10b981';
      box.innerHTML = `✅ [ONLINE] Đã cộng dồn & ghi Log Dòng 1: <strong>${tag}</strong> (${user} @ ${loc})`;
    }
  }
  tagEl.focus();
}

function editPdaRowById(scanId, fallbackIdx = -1) {
  const idx = findScanIndexById(scanId, fallbackIdx);
  if (idx < 0 || idx >= AppState.scanRaw.length) return;
  const row = AppState.scanRaw[idx];
  if (!row.scanId) row.scanId = generateScanId(row.user || 'U', 'ROW');

  const r = AppState.reconciled;
  const st = r ? r.filteredStockByBatch.get(row.tag) : null;
  const otherSt = (!st && r && r.otherStockByBatch.get(row.tag)) ? r.otherStockByBatch.get(row.tag)[0] : null;
  const qty = (Number(row.manualQty) > 0) ? Number(row.manualQty) : (st ? st.qty : (otherSt ? otherSt.qty : 0));

  AppState.editingScanIndex = idx;
  AppState.editingScanId = row.scanId;

  document.getElementById('pda-input-user').value = row.user || '';
  document.getElementById('pda-input-loc').value = row.loc || '';
  document.getElementById('pda-input-tag').value = row.tag || '';
  document.getElementById('pda-input-qty').value = qty || '';

  const okBtn = document.getElementById('pda-ok-btn');
  if (okBtn) {
    okBtn.textContent = `LƯU #${idx + 1}`;
    okBtn.classList.add('editing-mode');
  }

  const box = document.getElementById('pda-live-lookup');
  if (box) {
    box.style.borderColor = '#f59e0b';
    box.innerHTML = `✏️ Đang sửa Dòng #${idx + 1} (${row.tag} - ${row.user}) — An toàn đa người dùng`;
  }
  document.getElementById('pda-input-tag').focus();
}

function editPdaRow(idx) {
  const row = AppState.scanRaw[idx];
  editPdaRowById(row ? row.scanId : null, idx);
}

function cancelPdaEditMode() {
  AppState.editingScanIndex = -1;
  AppState.editingScanId = null;
  const okBtn = document.getElementById('pda-ok-btn');
  if (okBtn) {
    okBtn.textContent = 'OK';
    okBtn.classList.remove('editing-mode');
  }
  const tagEl = document.getElementById('pda-input-tag');
  const qtyEl = document.getElementById('pda-input-qty');
  if (tagEl) tagEl.value = '';
  if (qtyEl) qtyEl.value = '';
}

function deletePdaRowById(scanId, fallbackIdx = -1) {
  const idx = findScanIndexById(scanId, fallbackIdx);
  if (idx < 0 || idx >= AppState.scanRaw.length) return;
  const removed = AppState.scanRaw.splice(idx, 1)[0];

  if (removed) {
    recordPdaActivity('DELETE', removed);
    persistMultiUserAndOfflineScan(removed, 'DELETE');
  }

  if (AppState.editingScanId && removed && AppState.editingScanId === removed.scanId) {
    cancelPdaEditMode();
  } else if (AppState.editingScanId) {
    AppState.editingScanIndex = findScanIndexById(AppState.editingScanId, -1);
  } else if (AppState.editingScanIndex === idx) {
    cancelPdaEditMode();
  } else if (AppState.editingScanIndex > idx) {
    AppState.editingScanIndex--;
  }

  refreshScanFileNameLabel();
  runMultiAgentReconciliation();
  const box = document.getElementById('pda-live-lookup');
  if (box && removed) {
    box.style.borderColor = '#f43f5e';
    box.innerHTML = `🗑️ Đã xóa dòng Tag <strong>${removed.tag}</strong> (${removed.user || '-'}) & cập nhật đối soát`;
  }
}

function deletePdaRow(idx) {
  const row = AppState.scanRaw[idx];
  deletePdaRowById(row ? row.scanId : null, idx);
}

function editLatestPdaScan() {
  if (AppState.scanRaw.length === 0) return;
  editPdaRowById(AppState.scanRaw[0].scanId, 0);
}

function deleteLatestPdaScan() {
  if (AppState.scanRaw.length === 0) return;
  deletePdaRowById(AppState.scanRaw[0].scanId, 0);
}

// Simulate multiple users scanning concurrently at the exact same moment without collision
function simulateConcurrentMultiUserScan() {
  const r = AppState.reconciled;
  if (!r) return 0;
  const missingTags = r.tagDetails.filter((t) => !t.isScanned).slice(0, 4);
  if (missingTags.length === 0) {
    const box = document.getElementById('pda-live-lookup');
    if (box) box.innerHTML = '✅ Tất cả TagID trong phạm vi đã được quét đủ 100%!';
    return 0;
  }

  const concurrentUsers = ['Thanh', 'Minh', 'Tuấn', 'Lan'];
  const insertedRecords = [];

  missingTags.forEach((item, i) => {
    const u = concurrentUsers[i % concurrentUsers.length];
    const res = performAtomicScanSubmission({
      user: u,
      loc: item.bin || `010${i + 1}`,
      tag: item.batch,
      manualQty: item.stockQty
    });
    if (res && res.record) insertedRecords.push(res.record);
  });

  const box = document.getElementById('pda-live-lookup');
  if (box) {
    box.style.borderColor = '#38bdf8';
    box.innerHTML = `👥 Đã ghi nhận đồng thời <strong>${insertedRecords.length} người dùng</strong> (${insertedRecords.map((x) => x.user).join(', ')}) quét cùng lúc 0 lỗi!`;
  }
  return insertedRecords.length;
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

  // Render 100% of scanRaw rows in the PDA log table without any slice limit
  tbody.innerHTML = AppState.scanRaw.map((s, idx) => {
    if (!s.scanId) s.scanId = generateScanId(s.user || 'U', 'ROW');
    const safeId = String(s.scanId).replace(/'/g, "\\'");
    const st = r.filteredStockByBatch.get(s.tag);
    const otherSt = (!st && r.otherStockByBatch.get(s.tag)) ? r.otherStockByBatch.get(s.tag)[0] : null;
    const scansForTag = r.scanByTag.get(s.tag) || [];
    const qty = (Number(s.manualQty) > 0) ? Number(s.manualQty) : (st ? st.qty : (otherSt ? otherSt.qty : 0));
    const isDup = scansForTag.length > 1;
    const tagColor = (!st && !otherSt) ? '#f43f5e' : (!st && otherSt ? '#c084fc' : (isDup ? '#fbbf24' : '#34d399'));
    const statusIcon = (s.offlineQueued || s.syncStatus === 'OFFLINE_PENDING') ? '📴' : '🟢';

    return `
      <tr class="${s.isNew ? 'new-scan-highlight' : ''}">
        <td><strong>${idx + 1}</strong></td>
        <td>
          <button class="row-action-btn" onclick="editPdaRowById('${safeId}', ${idx})" title="Sửa dòng này">✏️</button>
          <button class="row-action-btn del" onclick="deletePdaRowById('${safeId}', ${idx})" title="Xóa dòng này">🗑️</button>
        </td>
        <td style="font-family:'JetBrains Mono',monospace; font-weight:700; color:${tagColor};">${s.tag}</td>
        <td>${s.loc || '-'}</td>
        <td class="num-col"><strong>${fmtNum(qty)}</strong></td>
        <td>${s.user || '-'} ${statusIcon}</td>
      </tr>
    `;
  }).join('');
}

/* ==========================================================================
   UNIVERSAL FILE IMPORTER & CLEAR DATA CONTROLS (XÓA DỮ LIỆU CŨ VỀ 0 & NHẬP THÊM CỘNG DỒN)
   ========================================================================== */
function clearStockData() {
  AppState.stockRaw = [];
  AppState.stockFileName = 'Đã xóa (0 dòng)';
  const el = document.getElementById('input-file-stock');
  if (el) el.value = '';
  runMultiAgentReconciliation();
}

function clearScanData() {
  AppState.scanRaw = [];
  AppState.scanSources = [];
  AppState.offlineActivityLog = [];
  AppState.scanFileName = 'Đã xóa (0 dòng)';
  safeWriteStorageArray(STORAGE_KEYS.SHARED_SCANS, []);
  safeWriteStorageArray(STORAGE_KEYS.OFFLINE_QUEUE, []);
  safeWriteStorageArray(STORAGE_KEYS.DELETED_IDS, []);
  cancelPdaEditMode();
  const el1 = document.getElementById('input-file-scan');
  const el2 = document.getElementById('input-file-scan-append');
  if (el1) el1.value = '';
  if (el2) el2.value = '';
  runMultiAgentReconciliation();
}

function clearAllSources() {
  AppState.stockRaw = [];
  AppState.scanRaw = [];
  AppState.scanSources = [];
  AppState.offlineActivityLog = [];
  AppState.stockFileName = 'Đã xóa (0 dòng)';
  AppState.scanFileName = 'Đã xóa (0 dòng)';
  safeWriteStorageArray(STORAGE_KEYS.SHARED_SCANS, []);
  safeWriteStorageArray(STORAGE_KEYS.OFFLINE_QUEUE, []);
  safeWriteStorageArray(STORAGE_KEYS.DELETED_IDS, []);
  cancelPdaEditMode();
  const elStock = document.getElementById('input-file-stock');
  const elScan = document.getElementById('input-file-scan');
  const elAppend = document.getElementById('input-file-scan-append');
  if (elStock) elStock.value = '';
  if (elScan) elScan.value = '';
  if (elAppend) elAppend.value = '';
  runMultiAgentReconciliation();
}

function restoreDefaultData() {
  safeWriteStorageArray(STORAGE_KEYS.SHARED_SCANS, []);
  safeWriteStorageArray(STORAGE_KEYS.OFFLINE_QUEUE, []);
  safeWriteStorageArray(STORAGE_KEYS.DELETED_IDS, []);
  AppState.offlineActivityLog = [];
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

function extractScanRowsFromRaw(rows, sourceName, markNew = false) {
  const parsed = [];
  const offlineMode = !isEffectiveOnline();
  rows.forEach((r, idx) => {
    if (Array.isArray(r)) {
      const tag = String(r[1] !== undefined ? r[1] : r[0] || '').trim();
      if (tag && tag.toLowerCase() !== 'tag id' && tag.toLowerCase() !== 'tagid') {
        const user = String(r[3] || '').trim();
        parsed.push({
          scanId: generateScanId(user || 'FILE', 'FILE'),
          stt: String(r[0] || idx + 1).trim(),
          tag,
          loc: String(r[2] || '').trim(),
          user,
          time: String(r[4] || '').trim(),
          manualQty: Number(String(r[5] || '0').replace(/,/g, '')) || 0,
          isNew: markNew,
          offlineQueued: markNew && offlineMode,
          syncStatus: markNew && offlineMode ? 'OFFLINE_PENDING' : 'SYNCED',
          source: sourceName
        });
      }
    } else if (r && typeof r === 'object') {
      const stt = String(pickCol(r, ['STT', 'No', 'ID', 'Dòng'], 0) || idx + 1).trim();
      const tag = String(pickCol(r, ['Tag ID', 'TagID', 'BATCH', 'Batch', 'Mã vạch', 'Barcode', 'tag'], 1)).trim();
      const loc = String(pickCol(r, ['Vị trí', 'Vi tri', 'Bin Location', 'BIN', 'Location', 'loc'], 2)).trim();
      const user = String(pickCol(r, ['User quét', 'User', 'USE', 'Người quét', 'Nhân viên', 'user'], 3)).trim();
      const time = String(pickCol(r, ['Thời gian quét', 'Thời gian', 'Time', 'Timestamp', 'time'], 4)).trim();
      const manualQty = Number(String(pickCol(r, ['Qty', 'Số lượng', 'SL', 'manualQty'], 5) || '0').replace(/,/g, '')) || 0;
      if (tag && tag.toLowerCase() !== 'tag id' && tag.toLowerCase() !== 'tagid') {
        parsed.push({
          scanId: r.scanId || generateScanId(user || 'FILE', 'FILE'),
          stt,
          tag,
          loc,
          user,
          time,
          manualQty,
          isNew: markNew,
          offlineQueued: markNew && offlineMode,
          syncStatus: markNew && offlineMode ? 'OFFLINE_PENDING' : 'SYNCED',
          source: sourceName
        });
      }
    }
  });
  return parsed;
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
    AppState.stockFileName = `${file.name} (${fmtNum(parsed.length)} dòng)`;
    event.target.value = '';
    runMultiAgentReconciliation();
  });
}

function handleScanFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  parseUniversalFile(file, (rows) => {
    const parsed = extractScanRowsFromRaw(rows, file.name, false);
    AppState.scanRaw = parsed;
    AppState.scanSources = [file.name];
    refreshScanFileNameLabel();
    event.target.value = '';
    runMultiAgentReconciliation();
  });
}

function appendScanDataRows(rows, sourceName = 'File nhập thêm') {
  const parsed = extractScanRowsFromRaw(rows, sourceName, true);
  if (parsed.length === 0) return 0;
  // Cộng dồn (accumulate) vào dữ liệu kiểm kê hiện tại ở Bảng 2 và đưa các dòng mới lên đầu bảng ghi log
  AppState.scanRaw = [...parsed, ...AppState.scanRaw];
  if (!AppState.scanSources.includes(sourceName)) {
    AppState.scanSources.push(sourceName);
  }
  refreshScanFileNameLabel();
  runMultiAgentReconciliation();
  return parsed.length;
}

function handleScanFileAppendUpload(event) {
  const files = Array.from(event.target.files || []);
  if (files.length === 0) return;

  let processedFiles = 0;
  files.forEach((file) => {
    parseUniversalFile(file, (rows) => {
      appendScanDataRows(rows, `+ ${file.name}`);
      processedFiles++;
      if (processedFiles === files.length) {
        event.target.value = '';
      }
    });
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
  threeRenderer.setSize(w, h, false);
  threeRenderer.domElement.style.width = '100%';
  threeRenderer.domElement.style.height = '340px';
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
  const panel = document.getElementById('panel-3d-main');
  if (!container || !threeRenderer || !threeCamera) return;

  const isExpanded = Boolean(panel && panel.classList.contains('expanded-3d'));
  if (!isExpanded && threeRenderer.domElement) {
    // Shrink WebGL drawing buffer first so intrinsic canvas attributes never hold the grid column wide
    threeRenderer.setSize(1, 1, false);
    threeRenderer.domElement.style.width = '100%';
    threeRenderer.domElement.style.height = '100%';
    container.style.width = '100%';
    container.style.height = '340px';
  }

  const w = Math.max(container.clientWidth || 520, 280);
  const h = isExpanded ? Math.max(container.clientHeight || 620, 420) : 340;
  threeCamera.aspect = w / h;
  threeCamera.updateProjectionMatrix();
  threeRenderer.setSize(w, h, false);
  if (threeRenderer.domElement) {
    threeRenderer.domElement.style.width = '100%';
    threeRenderer.domElement.style.height = '100%';
  }
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
  const panel = document.getElementById('panel-3d-main');
  if (panel) {
    panel.classList.toggle('zoomed-3d', Math.abs(threeCamera.position.z - 14.2) > 0.5);
  }
}

function reset3DView() {
  targetRotY = 0.0;
  targetRotX = 0.15;
  const panel = document.getElementById('panel-3d-main');
  if (panel) {
    panel.classList.remove('expanded-3d', 'zoomed-3d');
    panel.style.width = '';
    panel.style.height = '';
  }
  const backdrop = document.getElementById('three-expanded-backdrop');
  if (backdrop) {
    backdrop.classList.remove('open');
  }
  const expandBtn = document.getElementById('btn-3d-expand');
  if (expandBtn) {
    expandBtn.textContent = '⛶ Phóng Rộng';
    expandBtn.classList.remove('active');
  }
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
  resize3DScene();
}

// Khôi phục bảng 3D về đúng vị trí khung ban đầu (thoát phóng rộng, trả lại 3 bảng Dashboard song song, đặt lại cỡ thu phóng & góc xoay ban đầu)
function refresh3DInitialState() {
  targetRotY = 0.0;
  targetRotX = 0.18;
  isDragging3D = false;

  const panel = document.getElementById('panel-3d-main');
  if (panel) {
    panel.classList.remove('expanded-3d', 'zoomed-3d');
    panel.style.width = '';
    panel.style.height = '';
  }

  const backdrop = document.getElementById('three-expanded-backdrop');
  if (backdrop) {
    backdrop.classList.remove('open');
  }

  const expandBtn = document.getElementById('btn-3d-expand');
  if (expandBtn) {
    expandBtn.textContent = '⛶ Phóng Rộng';
    expandBtn.classList.remove('active');
  }

  const container = document.getElementById('three-canvas-container');
  if (container) {
    container.style.width = '100%';
    container.style.height = '340px';
  }

  if (threeCamera) {
    threeCamera.position.set(0, 6.2, 14.2);
    threeCamera.lookAt(0, 1.8, 0);
  }
  if (threeBarsGroup) {
    threeBarsGroup.rotation.set(0.18, 0, 0);
  }

  AppState.autoRotate3D = true;
  const btn = document.getElementById('btn-3d-pause');
  if (btn) {
    btn.textContent = '⏸️ Dừng Xoay';
    btn.classList.add('active');
  }

  resize3DScene();
  if (AppState.reconciled) {
    update3DScene(AppState.reconciled);
  }
  if (chartPrefixInstance && typeof chartPrefixInstance.resize === 'function') {
    chartPrefixInstance.resize();
  }
  if (chartUsersInstance && typeof chartUsersInstance.resize === 'function') {
    chartUsersInstance.resize();
  }
  setTimeout(resize3DScene, 30);
}

function toggleExpand3DPanel() {
  const panel = document.getElementById('panel-3d-main');
  if (!panel) return;
  const wasExpanded = panel.classList.contains('expanded-3d');
  if (wasExpanded) {
    refresh3DInitialState();
    return;
  }

  panel.classList.add('expanded-3d');
  const backdrop = document.getElementById('three-expanded-backdrop');
  if (backdrop) {
    backdrop.classList.add('open');
  }
  const expandBtn = document.getElementById('btn-3d-expand');
  if (expandBtn) {
    expandBtn.textContent = '🗗 Về Khung Đầu';
    expandBtn.classList.add('active');
  }
  resize3DScene();
  setTimeout(resize3DScene, 30);
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const panel = document.getElementById('panel-3d-main');
    if (panel && (panel.classList.contains('expanded-3d') || panel.classList.contains('zoomed-3d'))) {
      refresh3DInitialState();
    }
  }
});

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
    ['BÁO CÁO ĐỐI SOÁT TỒN KHO & KIỂM KÊ THỰC TẾ PDA (KHO 01 & 61 | MÃ HÀNG 3*, 5*, 7* + ĐỐI SOÁT TAG KHO KHÁC)'],
    ['Ngày xuất báo cáo:', new Date().toLocaleString('vi-VN')],
    ['Nguồn Tồn Kho:', AppState.stockFileName, 'Nguồn Kiểm Kê Cộng Dồn:', AppState.scanFileName],
    [],
    ['CHỈ SỐ KPI TỔNG QUAN', 'GIÁ TRỊ', 'TỶ LỆ / GHI CHÚ'],
    ['1. Tổng Số Lượng Tồn Kho (Kho 01 & 61 | 3*, 5*, 7*)', r.totalStockQty, `${r.totalStockTags} TagID (${r.uniqueItemCodesCount} Mã hàng)`],
    ['2. Số Lượng Kiểm Được Tại Kho 01 & 61 (Khớp TagID)', r.totalScannedQty, fmtPct(r.totalStockQty ? (r.totalScannedQty / r.totalStockQty) * 100 : 0)],
    ['3. Số Lượng Thiếu Tại Kho 01 & 61 (Chưa cộng Tag kho khác)', r.totalMissingQty, fmtPct(r.totalStockQty ? (r.totalMissingQty / r.totalStockQty) * 100 : 0)],
    ['4. Số Lượng Quét Được Tag Nhưng Đang Ở Kho Khác (Mã 3*, 5*, 7*)', r.otherWhSamePfxQty, `${r.otherWhSamePfxTags} TagID thuộc Kho 62, 60, 50 trên sổ tồn`],
    ['5. Số Lượng Quét Được Tag Khác Nhóm Mã (Mã 1*, 9*)', r.otherPfxQty, `${r.otherPfxTags} TagID (Tổng cộng có sổ ngoài phạm vi: ${r.unmatchedOtherWhCount} Tag = ${fmtNum(r.unmatchedOtherWhQty)} SL)`],
    ['6. Tổng SL Kiểm Được Sau Khi Cộng Tag Ở Kho Khác (3*, 5*, 7*)', r.totalScannedInclOtherWhQty, fmtPct(r.totalStockQty ? (r.totalScannedInclOtherWhQty / r.totalStockQty) * 100 : 0)],
    ['7. Chênh Lệch Tồn Kho Sau Khi Cộng Tag Ở Kho Khác', r.netDiffAfterOtherWhQty, `Còn thiếu: ${fmtNum(Math.max(0, -r.netDiffAfterOtherWhQty))} SL`],
    ['8. Cảnh Báo TagID Quét Trùng (Đã khử trùng lặp)', r.duplicateAlerts.length, `${r.totalExtraDuplicateScans} lượt quét dư (Ngăn chặn +${fmtNum(r.totalPreventedInflatedQty)} SL ảo)`],
    ['9. Cảnh Báo Lệch Vị Trí (BIN Tồn ≠ Vị Trí Quét)', r.totalLocMismatch, 'TagID khớp nhưng khác vị trí BIN trên sổ'],
    ['10. TagID Chưa Có Trên Danh Sách Tồn Kho', r.unmatchedUnknownCount, `Tổng dòng ghi Log: ${AppState.scanRaw.length}`],
    [],
    ['BẢNG TỔNG HỢP THEO TỪNG KHO (01, 61) & NHÓM MÃ HÀNG (3*, 5*, 7*) KÈM ĐỐI SOÁT TAG KHO KHÁC'],
    ['Kho (WH)', 'Nhóm Mã Hàng', 'Số Mã Hàng', 'Tổng Tag Tồn', 'Tag Kiểm (01/61)', 'Tag Thiếu (01/61)', 'Tỷ Lệ Tag (%)', 'Tổng SL Tồn Kho', 'SL Kiểm (01/61)', 'SL Thiếu (01/61)', 'Tag Quét Kho Khác', 'SL Quét Kho Khác', 'Tổng SL Kiểm (Gồm Kho Khác)', 'Chênh Lệch Tồn (Gồm Kho Khác)', 'Tỷ Lệ Đạt SL (%)']
  ];

  for (const m of r.matrixRows) {
    const tagPct = m.stockTags > 0 ? Number(((m.scannedTags / m.stockTags) * 100).toFixed(2)) : 0;
    const totalWithOther = m.scannedQty + m.otherWhQty;
    const diffWithOther = totalWithOther - m.stockQty;
    const qtyPct = m.stockQty > 0 ? Number(((totalWithOther / m.stockQty) * 100).toFixed(2)) : 0;
    execRows.push([
      m.wh, m.prefix, m.items.size, m.stockTags, m.scannedTags, m.missingTags, tagPct,
      m.stockQty, m.scannedQty, m.missingQty, m.otherWhTags, m.otherWhQty, totalWithOther, diffWithOther, qtyPct
    ]);
  }
  const wsExec = XLSX.utils.aoa_to_sheet(execRows);
  XLSX.utils.book_append_sheet(wb, wsExec, '1_Tong_Hop_Bao_Cao');

  // SHEET 2: TỔNG HỢP THEO TỪNG MÃ HÀNG & VỊ TRÍ (CÓ ĐỐI SOÁT KHO KHÁC)
  const itemRows = r.itemSummaries.map((it, idx) => ({
    'STT': idx + 1,
    'Kho (Warehouse)': it.wh,
    'Mã Hàng (Stock Code)': it.code,
    'Nhóm Mã': it.prefix,
    'Tổng Tag Tồn (01/61)': it.stockTags,
    'Tag Kiểm Được (01/61)': it.scannedTags,
    'Tag Thiếu (01/61)': it.missingTags,
    'Số Lượng Tồn Kho (01/61)': it.stockQty,
    'Số Lượng Kiểm Được (01/61)': it.scannedQty,
    'Số Lượng Thiếu (01/61)': it.missingQty,
    'Số Tag Quét Ở Kho Khác': it.otherWhTags,
    'Kho Khác Trên Sổ': it.otherWhsStr,
    'SL Quét Ở Kho Khác': it.otherWhQty,
    'Tổng SL Kiểm (Gồm Kho Khác)': it.totalScannedWithOtherWh,
    'Chênh Lệch So Với Tồn (01/61)': it.netDiffWithOtherWh,
    'Tổng Tồn Toàn Kho': it.allWhStockQty,
    'Tỷ Lệ Đạt SL (%)': Number(it.pctQtyWithOtherWh.toFixed(2)),
    'Vị Trí Tồn Sổ (BIN)': it.binsStr,
    'Vị Trí Quét Thực Tế': it.scanLocsStr,
    'Số Tag Quét Trùng': it.dupTags,
    'Số Tag Lệch Vị Trí': it.locDiffTags
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

  // SHEET 4: ĐỐI SOÁT TAG QUÉT Ở KHO KHÁC & CẢNH BÁO TRÙNG
  const alertRows = [];
  for (const it of r.otherWhItemRows) {
    alertRows.push({
      'Loại Đối Soát': `TỔNG HỢP MÃ HÀNG CÓ TAG Ở KHO KHÁC (${it.otherWhsStr})`,
      'TagID / Batch': `${it.otherWhTags} Tag (${it.tagList.map((t) => t.tag).join(', ')})`,
      'Số Lần Quét': it.otherWhTags,
      'Kho Trên Sổ': it.otherWhsStr,
      'Mã Hàng': it.code,
      'SL Quét Ở Kho Khác': it.otherWhQty,
      'SL Tồn Kho (01/61)': it.stock0161Qty,
      'SL Đã Quét (01/61)': it.scanned0161Qty,
      'Tổng SL Đã Quét (01/61 + Kho Khác)': it.totalScannedInclOtherWh,
      'Chênh Lệch So Với Tồn (01/61)': it.diffVs0161Stock,
      'Tổng Tồn Toàn Kho': it.allWhStockQty,
      'Chi Tiết Lượt Quét / Ngoại Lệ': it.tagList.map((t) => `${t.tag} [Kho ${t.wh}: ${fmtNum(t.qty)} SL @ ${t.scanLoc}]`).join(' | ')
    });
  }
  for (const u of r.unmatchedAlerts) {
    alertRows.push({
      'Loại Đối Soát': u.typeLabel,
      'TagID / Batch': u.tag,
      'Số Lần Quét': u.count,
      'Kho Trên Sổ': u.wh,
      'Mã Hàng': u.code,
      'SL Quét Ở Kho Khác': u.qty,
      'SL Tồn Kho (01/61)': 0,
      'SL Đã Quét (01/61)': 0,
      'Tổng SL Đã Quét (01/61 + Kho Khác)': u.qty,
      'Chênh Lệch So Với Tồn (01/61)': u.qty,
      'Tổng Tồn Toàn Kho': u.qty,
      'Chi Tiết Lượt Quét / Ngoại Lệ': `${u.user} @ ${u.loc} (${u.time}) -> ${u.info}`
    });
  }
  for (const d of r.duplicateAlerts) {
    alertRows.push({
      'Loại Đối Soát': 'TRÙNG TAGID (DUPLICATE)',
      'TagID / Batch': d.tag,
      'Số Lần Quét': d.count,
      'Kho Trên Sổ': d.wh,
      'Mã Hàng': d.code,
      'SL Quét Ở Kho Khác': d.unitQty,
      'SL Tồn Kho (01/61)': d.unitQty,
      'SL Đã Quét (01/61)': d.unitQty,
      'Tổng SL Đã Quét (01/61 + Kho Khác)': d.unitQty,
      'Chênh Lệch So Với Tồn (01/61)': 0,
      'Tổng Tồn Toàn Kho': d.unitQty,
      'Chi Tiết Lượt Quét / Ngoại Lệ': `SL ảo đã chặn: +${fmtNum(d.preventedQty)} | ` + d.scans.map((s) => `STT ${s.stt}: ${s.user} @ ${s.loc} (${s.time})`).join(' | ')
    });
  }
  const wsAlerts = XLSX.utils.json_to_sheet(alertRows);
  XLSX.utils.book_append_sheet(wb, wsAlerts, '4_Doi_Soat_Tag_Kho_Khac');

  // SHEET 5: BẢNG GHI LOG DỮ LIỆU QUÉT PDA & CỘNG DỒN (100% ĐẦY ĐỦ + TRẠNG THÁI ĐỒNG BỘ ĐA USER / OFFLINE)
  const pdaRows = AppState.scanRaw.map((s, idx) => {
    const st = r.filteredStockByBatch.get(s.tag);
    const otherSt = (!st && r.otherStockByBatch.get(s.tag)) ? r.otherStockByBatch.get(s.tag)[0] : null;
    return {
      'Thứ Tự Dòng Log': idx + 1,
      'Mã Định Danh (Scan ID)': s.scanId || `ROW-${idx + 1}`,
      'STT Gốc': s.stt,
      'Tag ID': s.tag,
      'Bin Location': s.loc,
      'USE': s.user,
      'Thời Gian Quét (PDA)': s.time,
      'Nguồn Dữ Liệu': s.source || 'File kiểm kê',
      'Trạng Thái Đồng Bộ': (s.offlineQueued || s.syncStatus === 'OFFLINE_PENDING') ? 'OFFLINE (Chờ đồng bộ)' : 'ONLINE (Đã đồng bộ)',
      'Thời Gian Đồng Bộ': s.syncedAt || s.time || '-',
      'Mã Hàng Khớp': st ? st.code : (otherSt ? otherSt.code : 'Chưa có trên sổ'),
      'Kho Trên Sổ': st ? st.wh : (otherSt ? otherSt.wh : '-'),
      'Qty': (Number(s.manualQty) > 0) ? Number(s.manualQty) : (st ? st.qty : (otherSt ? otherSt.qty : 0))
    };
  });
  const wsPda = XLSX.utils.json_to_sheet(pdaRows);
  XLSX.utils.book_append_sheet(wb, wsPda, '5_Du_Lieu_Quet_PDA');

  // SHEET 6: NHẬT KÝ HOẠT ĐỘNG QUÉT OFFLINE / ĐỒNG BỘ ĐA NGƯỜI DÙNG
  const actSource = AppState.offlineActivityLog.length > 0
    ? AppState.offlineActivityLog
    : [{ id: 'SYNC-INIT', action: 'SYSTEM_READY', scanId: '-', tag: '-', loc: '-', user: 'System', qty: AppState.scanRaw.length, time: getNowTimeStr(), synced: true, syncedAt: getNowTimeStr() }];
  const actRows = actSource.map((a, idx) => ({
    'STT': idx + 1,
    'Mã Hoạt Động': a.id,
    'Loại Thao Tác': a.action,
    'Scan ID': a.scanId,
    'Tag ID': a.tag,
    'Vị Trí (Bin)': a.loc,
    'Người Dùng (USE)': a.user,
    'Số Lượng (Qty)': a.qty,
    'Thời Gian Thao Tác': a.time,
    'Trạng Thái Đồng Bộ': a.synced ? 'Đã đồng bộ Online' : 'Đang lưu đệm Offline',
    'Thời Điểm Đồng Bộ': a.syncedAt || '-'
  }));
  const wsAct = XLSX.utils.json_to_sheet(actRows);
  XLSX.utils.book_append_sheet(wb, wsAct, '6_Nhat_Ky_Dong_Bo_PDA');

  XLSX.writeFile(wb, 'Bao_Cao_Doi_Soat_Ton_Kho_31.10.2026.xlsx');
}

function exportPdaScansOnly() {
  const r = AppState.reconciled;
  const wb = XLSX.utils.book_new();
  const pdaRows = AppState.scanRaw.map((s, idx) => {
    const st = r ? r.filteredStockByBatch.get(s.tag) : null;
    const otherSt = (!st && r && r.otherStockByBatch.get(s.tag)) ? r.otherStockByBatch.get(s.tag)[0] : null;
    return {
      'STT': idx + 1,
      'Scan ID': s.scanId || `ROW-${idx + 1}`,
      'Tag ID': s.tag,
      'Bin Location': s.loc,
      'USE': s.user,
      'Qty': (Number(s.manualQty) > 0) ? Number(s.manualQty) : (st ? st.qty : (otherSt ? otherSt.qty : 0)),
      'Thời gian quét (PDA)': s.time,
      'Trạng thái đồng bộ': (s.offlineQueued || s.syncStatus === 'OFFLINE_PENDING') ? 'OFFLINE (Chờ đồng bộ)' : 'ONLINE (Đã đồng bộ)',
      'Thời điểm đồng bộ': s.syncedAt || s.time || '-',
      'Nguồn dữ liệu': s.source || 'File kiểm kê',
      'Mã hàng': st ? st.code : (otherSt ? otherSt.code : ''),
      'Kho trên sổ': st ? st.wh : (otherSt ? otherSt.wh : '')
    };
  });
  const ws = XLSX.utils.json_to_sheet(pdaRows);
  XLSX.utils.book_append_sheet(wb, ws, 'Du_Lieu_Quet_PDA');

  if (AppState.offlineActivityLog.length > 0) {
    const actRows = AppState.offlineActivityLog.map((a, idx) => ({
      'STT': idx + 1,
      'Thao tác': a.action,
      'Scan ID': a.scanId,
      'Tag ID': a.tag,
      'Bin Location': a.loc,
      'USE': a.user,
      'Qty': a.qty,
      'Thời gian quét Offline/Online': a.time,
      'Đã đồng bộ': a.synced ? 'Đã đồng bộ' : 'Chờ đồng bộ',
      'Thời gian đồng bộ': a.syncedAt || '-'
    }));
    const wsAct = XLSX.utils.json_to_sheet(actRows);
    XLSX.utils.book_append_sheet(wb, wsAct, 'Nhat_Ky_Hoat_Dong_Offline');
  }

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
    AppState.scanRaw = window.DEFAULT_SCAN_DATA.map((r, idx) => ({
      scanId: `BASE-${idx + 1}-${r[1]}`,
      stt: r[0],
      tag: r[1],
      loc: r[2],
      user: r[3],
      time: r[4],
      manualQty: 0,
      isNew: false,
      offlineQueued: false,
      syncStatus: 'SYNCED',
      source: 'kiêm kho 31.10.2026.xlsx'
    }));
    AppState.scanSources = ['kiêm kho 31.10.2026.xlsx'];
  }
  // Load any stored offline activity log & merge pending offline/multi-user scans
  AppState.offlineActivityLog = safeReadStorageArray(STORAGE_KEYS.ACTIVITY_LOG);
  mergeExternalMultiUserScans(false);
  refreshScanFileNameLabel();
}

window.InventoryAgentAPI = {
  getState: () => AppState,
  getReconciledSummary: () => AppState.reconciled,
  clearStockData,
  clearScanData,
  clearAllSources,
  restoreDefaultData,
  appendScanDataRows,
  refresh3DInitialState,
  toggleOfflineMode,
  syncOfflineScansNow,
  syncAndExportPdaExcel,
  syncAndExportFullExcel,
  simulateConcurrentMultiUserScan,
  performAtomicScanSubmission,
  scanTagFromPDA: (user, loc, tag, qty) => {
    document.getElementById('pda-input-user').value = user || 'Agent';
    document.getElementById('pda-input-loc').value = loc || '';
    document.getElementById('pda-input-tag').value = tag || '';
    document.getElementById('pda-input-qty').value = qty || '';
    submitPdaScan();
  },
  editPdaRow,
  editPdaRowById,
  deletePdaRow,
  deletePdaRowById,
  exportFullExcelReport,
  exportPdaScansOnly
};

// Listen for network Online/Offline transitions and multi-user cross-tab storage events
window.addEventListener('online', () => {
  AppState.isOnline = true;
  if (!AppState.manualOfflineMode && getPendingOfflineScansCount() > 0) {
    syncOfflineScansNow({ silent: false });
  } else {
    updateNetworkAndMultiUserUI();
  }
});

window.addEventListener('offline', () => {
  AppState.isOnline = false;
  updateNetworkAndMultiUserUI();
});

window.addEventListener('storage', (e) => {
  if (!e || !e.key) return;
  if (
    e.key === STORAGE_KEYS.SHARED_SCANS ||
    e.key === STORAGE_KEYS.OFFLINE_QUEUE ||
    e.key === STORAGE_KEYS.DELETED_IDS
  ) {
    if (isEffectiveOnline()) {
      mergeExternalMultiUserScans(true);
    }
  }
});

if (pdaBroadcastChannel) {
  pdaBroadcastChannel.onmessage = (ev) => {
    if (ev && ev.data && ev.data.type === 'PDA_MULTIUSER_EVENT' && isEffectiveOnline()) {
      mergeExternalMultiUserScans(true);
    }
  };
}

window.addEventListener('DOMContentLoaded', () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .register('./sw.js?v=20261031-4')
      .then((reg) => {
        if (reg && typeof reg.update === 'function') reg.update();
      })
      .catch(() => {});
  }
  init3DScene();
  loadInitialBundle();
  runMultiAgentReconciliation();
  if (window.location.hash === '#pda' || window.AUTO_OPEN_PDA_MODAL) {
    openPdaModal();
  }
});
