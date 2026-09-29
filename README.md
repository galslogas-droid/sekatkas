# Sekat Kas Kopontren

**Pemisah dana. Penjaga amanah.**

Aplikasi PWA pencatat arus kas rekening Kopontren Al Ittihad yang ditampung sementara di rekening pribadi developer.

## 🚀 Fitur Utama

- ✅ Pencatatan dana masuk/keluar dengan 3 tingkat status
- ✅ Sinkronisasi otomatis ke Google Sheets
- ✅ Multi-user dengan role (Admin/Bendahara/Auditor)
- ✅ PIN lock & mode audit (read-only)
- ✅ Backup JSON & restore
- ✅ Rekonsiliasi bank otomatis dari mutasi CSV
- ✅ Laporan WhatsApp, CSV, PDF
- ✅ Grafik statistik (bar & pie)
- ✅ Anggaran bulanan & tagihan berulang
- ✅ PWA — bisa di-install di HP

## 📦 Cara Deploy

### 1. Frontend (GitHub Pages)
1. Upload semua file ke repository GitHub
2. Aktifkan GitHub Pages di Settings → Pages
3. Pilih branch `main` → folder `/root`
4. Akses di `https://username.github.io/sekat-kas-kopontren/`

### 2. Backend (Google Apps Script)
1. Buat spreadsheet "Sekat Kas Kopontren" di Google Sheets
2. Menu: Extensions → Apps Script
3. Paste isi `Code.gs`
4. Deploy → New Deployment → Web App
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Copy Web App URL
6. Buka aplikasi → Pengaturan → Sinkronisasi → paste URL + token

## 🔧 Konfigurasi

- **Token default:** `sekatkas-default-token-2026`
- Ganti token di Apps Script → Project Settings → Script Properties → `SYNC_TOKEN`

## 📱 Cara Install PWA

- **Android:** Buka di Chrome → Menu → "Add to Home Screen"
- **iOS:** Buka di Safari → Share → "Add to Home Screen"

## 📄 Lisensi

MIT License — bebas digunakan untuk kebaikan umat.

## 🙏 Kredit

Dibuat untuk Kopontren Al Ittihad.
"Pemisah dana. Penjaga amanah."