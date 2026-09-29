/**
 * ============================================================================
 * SEKAT KAS KOPONTREN — Google Apps Script Backend
 * ----------------------------------------------------------------------------
 * Backend sinkronisasi untuk aplikasi PWA "Sekat Kas Kopontren" (index.html).
 * Diproyeksikan 1:1 dengan kontrak sinkronisasi frontend:
 *   - POST  { action:'upsert',      token, device, sheet, record }
 *       -> { ok, error, skipped? }
 *   - POST  { action:'delete',      token, device, sheet, id }
 *       -> { ok, error }
 *   - POST  { action:'export_all',  token, device, sheet, records, count }
 *       -> { ok, sheetUrl, count }
 *   - GET   ?token=..&action=test&sheet=..   -> { ok, message }
 *   - GET   ?token=..&sheet=.. (tanpa action = list) -> { ok, rows, count }
 *
 * Cara Deploy:
 * 1. Buka (atau buat) spreadsheet "Sekat Kas Kopontren" di Google Sheets.
 * 2. Menu: Extensions -> Apps Script.
 * 3. Hapus isi Code.gs default, paste seluruh kode ini, simpan (Ctrl+S).
 * 4. Deploy -> New deployment -> Web app:
 *      - Execute as: Me
 *      - Who has access: Anyone
 *    Klik Deploy, izinkan permission, copy "Web App URL" (berakhiran /exec).
 * 5. Di aplikasi Sekat Kas: Pengaturan -> Sinkronisasi Google Sheets,
 *    isi URL Web App + Token, klik Tes Koneksi.
 *
 * Konfigurasi Token:
 * - Default: 'sekatkas-default-token-2026' (konstanta DEFAULT_TOKEN di bawah).
 * - Token kustom: Project Settings -> Script Properties ->
 *   tambah SYNC_TOKEN = <token_rahasia_anda>.
 *   (atau jalankan fungsi setSyncToken() sekali dari editor).
 *
 * DESAIN SINKRONISASI (penting, sesuaikan dgn frontend):
 * - Kolom sheet adalah source-of-truth data STRUKTURAL. Field lokal-only
 *   (lampiran foto, buktiFoto, mataUang, kurs, jumlahAsli, isHutang) TIDAK
 *   di-merge balik oleh frontend; mereka tetap hidup di perangkat masing-masing.
 * - Kolom LampiranJSON bersifat INFORMASIONAL SAJA (audit visual di sheet).
 *   Terbatas 50.000 karakter per sel Sheets; lampiran besar diganti
 *   placeholder agar upsert TIDAK GAGAL (data foto tetap aman di perangkat).
 * - Guard "latest-wins": upsert dgn updatedAt LEBIH LAMA dari baris yang ada
 *   akan DIABAIKAN (skipped), konsisten dgn merge skSyncNow di frontend,
 *   agar multi-perangkat tidak saling menimpa data yang lebih baru.
 * - LockService mencegah tulis simultan (upsert vs export_all).
 * ============================================================================
 */

// =========================================================================
// KONFIGURASI
// =========================================================================
var SHEET_NAME = 'Sekat Kas Kopontren';
var DEFAULT_TOKEN = 'sekatkas-default-token-2026';

var HEADERS = [
  'ID', 'Tanggal', 'Jam', 'Jenis', 'Jumlah', 'Kategori', 'SumberTujuan',
  'Keterangan', 'Rekening', 'IsKopontren', 'Status', 'TanggalCair',
  'TanggalSetor', 'HashBeritaAcara', 'UpdatedAt', 'Deleted', 'Hash',
  'IsMigrated', 'IsHutang', 'TransferPairId', 'MataUang', 'Kurs',
  'JumlahAsli', 'LampiranJSON'
];

// Batas aman sel Sheets (limit absolut 50.000 karakter per sel).
var MAX_CELL_CHARS = 45000;

// =========================================================================
// ENTRY POINT: GET (test / list)
// =========================================================================
function doGet(e) {
  try {
    var params = (e && e.parameter) || {};
    var action = params.action || 'list'; // frontend pull TIDAK mengirim action
    var token = params.token || '';
    var sheetName = params.sheet || SHEET_NAME;

    if (!verifyToken(token)) {
      return jsonResponse({ ok: false, error: 'Token tidak valid', msg: 'Token tidak valid' });
    }

    if (action === 'test') {
      // Test ringan: verifikasi token + akses spreadsheet.
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      return jsonResponse({
        ok: true,
        message: 'Koneksi berhasil',
        spreadsheet: ss ? ss.getName() : '(tidak ada spreadsheet aktif)',
        sheet: sheetName
      });
    }

    if (action === 'list' || action === 'pull') {
      var rows = getAllRows(sheetName);
      return jsonResponse({ ok: true, rows: rows, count: rows.length });
    }

    return jsonResponse({ ok: false, error: 'Action tidak dikenal: ' + action });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message || String(err), msg: err.message || String(err) });
  }
}

// =========================================================================
// ENTRY POINT: POST (upsert / delete / export_all)
// Frontend mengirim body JSON dengan Content-Type: text/plain
// (pola standar Apps Script Web App agar browser tidak preflight).
// =========================================================================
function doPost(e) {
  try {
    var body = {};
    try {
      body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    } catch (pe) {
      return jsonResponse({ ok: false, error: 'Body bukan JSON valid', msg: 'Body bukan JSON valid' });
    }
    var action = body.action || '';
    var token = body.token || '';
    var sheetName = body.sheet || SHEET_NAME;

    if (!verifyToken(token)) {
      return jsonResponse({ ok: false, error: 'Token tidak valid', msg: 'Token tidak valid' });
    }

    if (action === 'upsert') {
      return handleUpsert(body.record, sheetName);
    }
    if (action === 'delete') {
      return handleDelete(body.id, sheetName);
    }
    if (action === 'export_all') {
      return handleExportAll(body.records, sheetName, body.device);
    }

    return jsonResponse({ ok: false, error: 'Action tidak dikenal: ' + action });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message || String(err), msg: err.message || String(err) });
  }
}
// =========================================================================
// HANDLER: UPSERT (Tambah/Update satu record, guard latest-wins)
// =========================================================================
function handleUpsert(record, sheetName) {
  if (!record || !record.id) {
    return jsonResponse({ ok: false, error: 'Record tidak valid', msg: 'Record tidak valid' });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getOrCreateSheet(sheetName);
    var lastRow = sheet.getLastRow();
    var data = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues() : [];

    // Cari baris dengan ID yang sama (kolom A)
    var rowIdx = -1;
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][0]) === String(record.id)) { rowIdx = i; break; }
    }

    var rowData = recordToRow(record);

    if (rowIdx > -1) {
      // Guard latest-wins: jangan timpa baris yang lebih baru dari yang masuk.
      var incoming = parseTs(record.updatedAt);
      var existing = parseTs(data[rowIdx][HEADERS.indexOf('UpdatedAt')]);
      if (existing > 0 && incoming > 0 && incoming < existing) {
        return jsonResponse({
          ok: true,
          skipped: true,
          message: 'Record lebih lama dari versi Sheets — diabaikan'
        });
      }
      sheet.getRange(rowIdx + 2, 1, 1, rowData.length).setValues([rowData]);
    } else {
      sheet.appendRow(rowData);
    }

    return jsonResponse({ ok: true, message: 'Upsert berhasil', id: record.id });
  } finally {
    lock.releaseLock();
  }
}

// =========================================================================
// HANDLER: DELETE (hapus baris berdasarkan ID — idempotent)
// =========================================================================
function handleDelete(id, sheetName) {
  if (!id) {
    return jsonResponse({ ok: false, error: 'ID tidak valid', msg: 'ID tidak valid' });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getOrCreateSheet(sheetName);
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      return jsonResponse({ ok: true, message: 'Record tidak ditemukan (sheet kosong)', id: id });
    }

    var data = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][0]) === String(id)) {
        sheet.deleteRow(i + 2); // 1-based + header
        return jsonResponse({ ok: true, message: 'Delete berhasil', id: id });
      }
    }

    // Tidak ditemukan -> tetap ok (idempotent), frontend memperlakukan sebagai sukses.
    return jsonResponse({ ok: true, message: 'Record tidak ditemukan (mungkin sudah dihapus)', id: id });
  } finally {
    lock.releaseLock();
  }
}

// =========================================================================
// HANDLER: EXPORT ALL (timpa seluruh isi sheet kecuali header)
// =========================================================================
function handleExportAll(records, sheetName, device) {
  if (!Array.isArray(records)) {
    return jsonResponse({ ok: false, error: 'Records harus berupa array', msg: 'Records harus berupa array' });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getOrCreateSheet(sheetName);

    // Hapus semua baris data kecuali header
    var lastRow = sheet.getLastRow();
    if (lastRow > 1) sheet.deleteRows(2, lastRow - 1);

    // Tulis ulang semua records (batch 500 baris/setValues; limit 50.000 sel).
    if (records.length > 0) {
      var rows = records.map(function (r) { return recordToRow(r); });
      var BATCH = 500;
      for (var start = 0; start < rows.length; start += BATCH) {
        var chunk = rows.slice(start, start + BATCH);
        sheet.getRange(start + 2, 1, chunk.length, HEADERS.length).setValues(chunk);
      }
    }

    var ssUrl = SpreadsheetApp.getActiveSpreadsheet().getUrl();
    return jsonResponse({
      ok: true,
      message: 'Export berhasil: ' + records.length + ' transaksi' + (device ? ' dari ' + device : ''),
      sheetUrl: ssUrl,
      count: records.length
    });
  } finally {
    lock.releaseLock();
  }
}

// =========================================================================
// HELPER: GET ALL ROWS (untuk action list/pull)
// Key object = nama header persis (ID, Tanggal, ..., LampiranJSON),
// sesuai pemetaan skSyncNow di frontend.
// =========================================================================
function getAllRows(sheetName) {
  var sheet = getOrCreateSheet(sheetName);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var data = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
  var rows = [];
  for (var i = 0; i < data.length; i++) {
    var r = data[i];
    if (!r[0]) continue; // skip baris kosong
    var obj = {};
    for (var c = 0; c < HEADERS.length; c++) {
      var v = r[c];
      if (v instanceof Date) {
        // Kolom yang sempat berubah jadi objek Date (mis. edit manual di UI)
        obj[HEADERS[c]] = v.toISOString();
      } else {
        obj[HEADERS[c]] = (v === '' ? null : v);
      }
    }
    rows.push(obj);
  }
  return rows;
}
// =========================================================================
// HELPER: RECORD -> ROW (urut kolom PERSIS seperti HEADERS, 24 kolom)
// =========================================================================
function recordToRow(record) {
  // LampiranJSON: hanya tulis bila muat di batas sel; selain itu placeholder
  // (kolom ini sekadar informasi audit — frontend TIDAK membaca-baliknya).
  var lamp = '';
  if (record.lampiran && record.lampiran.length) {
    try {
      var s = JSON.stringify(record.lampiran);
      lamp = s.length <= MAX_CELL_CHARS
        ? s
        : '[lampiran: ' + record.lampiran.length + ' file, terlalu besar utk sel sheet — tersimpan lokal di perangkat]';
    } catch (e) {
      lamp = '[lampiran tidak dapat diserialisasi]';
    }
  }

  return [
    record.id || '',
    record.tanggal || '',
    record.jam || '',
    record.jenis || '',
    (record.jumlah === undefined || record.jumlah === null || record.jumlah === '') ? 0 : record.jumlah,
    record.kategori || '',
    record.sumberTujuan || '',
    record.keterangan || '',
    record.rekening || '',
    record.isKopontren === true ? 'Ya' : 'Tidak',
    record.status || 'belum_cair',
    record.tanggalCair ? new Date(Number(record.tanggalCair)).toISOString() : '',
    record.tanggalSetor ? new Date(Number(record.tanggalSetor)).toISOString() : '',
    record.hashBeritaAcara || '',
    record.updatedAt ? new Date(Number(record.updatedAt)).toISOString() : '',
    record.deleted === true ? 'Ya' : 'Tidak',
    record.hash || '',
    record.isMigrated === true ? 'Ya' : 'Tidak',
    record.isHutang === true ? 'Ya' : 'Tidak',
    record.transferPairId || '',
    record.mataUang || 'IDR',
    (record.kurs === undefined || record.kurs === null) ? 1 : record.kurs,
    (record.jumlahAsli === undefined || record.jumlahAsli === null) ? (record.jumlah || 0) : record.jumlahAsli,
    lamp
  ];
}

// =========================================================================
// HELPER: GET OR CREATE SHEET (dengan header standar)
// =========================================================================
function getOrCreateSheet(sheetName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var name = sheetName || SHEET_NAME;
  var sheet = ss.getSheetByName(name);

  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }

  // Pastikan header tetap standar (jika diubah/kehilangan oleh user).
  var firstRow = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  if (firstRow[0] !== 'ID') {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  }

  return sheet;
}
// =========================================================================
// HELPER: VERIFY TOKEN
// Urutan: Script Properties (SYNC_TOKEN) jika ada, default selalu diterima
// (backward-compat; ubah DEFAULT_TOKEN bila ingin menonaktifkan default).
// =========================================================================
function verifyToken(token) {
  if (!token) return false;
  var saved = '';
  try { saved = PropertiesService.getScriptProperties().getProperty('SYNC_TOKEN') || ''; } catch (e) {}
  var allow = [DEFAULT_TOKEN];
  if (saved) allow.push(saved);
  return allow.indexOf(token) > -1;
}

// =========================================================================
// HELPER: PARSE TIMESTAMP (ISO string / ms number / Date / kosong -> 0)
// =========================================================================
function parseTs(v) {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  var t = Date.parse(String(v));
  return isNaN(t) ? 0 : t;
}

// =========================================================================
// HELPER: JSON RESPONSE
// =========================================================================
function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// =========================================================================
// UTILITY: SET TOKEN KUSTOM (jalankan sekali dari editor Apps Script)
// Ganti isi string di bawah, lalu run fungsi ini dari editor.
// =========================================================================
function setSyncToken() {
  var newToken = 'sekatkas-token-rahasia-anda-2026'; // <-- GANTI DI SINI
  PropertiesService.getScriptProperties().setProperty('SYNC_TOKEN', newToken);
  Logger.log('SYNC_TOKEN berhasil disimpan: ' + newToken);
}

// =========================================================================
// UTILITY: HAPUS TOKEN KUSTOM (kembali ke default saja)
// =========================================================================
function clearSyncToken() {
  PropertiesService.getScriptProperties().deleteProperty('SYNC_TOKEN');
  Logger.log('SYNC_TOKEN dihapus — hanya default yang aktif.');
}

// =========================================================================
// UTILITY: TEST END-TO-END DARI EDITOR (run sekali utk verifikasi)
// Menulis 1 record uji lalu menghapusnya. Cek hasil: View -> Logs.
// =========================================================================
function testBackend() {
  var testRecord = {
    id: 'TEST-' + Date.now(),
    tanggal: new Date().toISOString().slice(0, 10),
    jam: new Date().toTimeString().slice(0, 5),
    jenis: 'masuk',
    jumlah: 100000,
    kategori: 'Test',
    sumberTujuan: 'Testing Backend',
    keterangan: 'Test dari editor Apps Script',
    rekening: 'BCA',
    isKopontren: true,
    status: 'belum_cair',
    updatedAt: Date.now(),
    deleted: false,
    hash: 'test-hash'
  };

  var r1 = handleUpsert(testRecord, SHEET_NAME);
  Logger.log('UPSERT: ' + r1.getContent());
  var r2 = handleDelete(testRecord.id, SHEET_NAME);
  Logger.log('DELETE: ' + r2.getContent());
  var r3 = jsonResponse({ ok: true, message: 'Koneksi berhasil' });
  Logger.log('TEST:   ' + r3.getContent());
  Logger.log('Selesai. Jika semua ok:true, backend siap dipakai.');
}