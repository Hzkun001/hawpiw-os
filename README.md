# Hawpiw OS ⚡

**Coba langsung: https://hawpiw-os.pages.dev**

Sistem operasi web **satu file HTML**: ringan, jalan offline, tanpa server. Seluruh OS
(shell, kernel, filesystem, 3 aplikasi) saat ini berukuran **±38 KB (14 KB gzip)**.

```bash
npm install
npm run dev          # pengembangan
npm run build        # hasil: dist/index.html (satu file, bisa dibuka langsung dari disk)
npm run preview      # sajikan dist/ di http://localhost:4173
node tests/e2e.mjs http://localhost:4173/ chromium   # atau firefox / webkit
```

## Deploy (Cloudflare Pages)

```bash
npx wrangler login     # sekali saja
npm run deploy         # build + upload ke https://hawpiw-os.pages.dev
```

Catatan: wrangler 4.165 mengalihkan perintah `pages` ke sistem baru yang gagal untuk
project statis ini; flag `--force` memakai jalur Pages langsung. Upload kadang gagal
dengan `ECONNRESET` di jaringan yang tidak stabil. Aman diulang (upload berbasis hash).

## Performa

Target utama proyek ini adalah **performa saat dipakai** di perangkat murah, bukan cepat jadi.
`perf-budget.json` berisi anggaran; `tests/perf.mjs` mengukur di Chromium dengan CPU
diperlambat 4x dan gagal bila median melewati anggaran.

```bash
npm run build && npm run preview &
npm run perf -- http://localhost:4173/            # 15 sampel, ~40 detik
npm run perf -- http://localhost:4173/ --json hasil.json
```

Metodenya meniru [google/tachometer](https://github.com/google/tachometer) (kini diarsipkan):
browser baru per sampel, sampel pemanasan dibuang, dilaporkan median, IQR, dan interval
kepercayaan 95% median (bootstrap). Waktu diambil dari `performance.measure` milik OS
(`hawpiw:boot`, `hawpiw:launch:<app>`); RAM dari PSS proses renderer di `/proc` (Linux).

Hasil 0.1.0 (Linux, 4 core, CPU diperlambat 4x):

| Metrik | Median | Anggaran |
|---|---|---|
| Boot sampai shell siap | 213 ms | 300 ms |
| First contentful paint | 264 ms | 300 ms |
| Buka app pertama (cold start, termasuk proses sandbox baru) | 84 ms | 100 ms |
| Buka app berikutnya | 40–45 ms | 60 ms |
| RAM desktop (PSS) | 84 MB, di mana ~68 MB adalah Chromium sendiri | 95 MB |
| RAM tambahan per app | 14 MB | 18 MB |
| Ukuran (gzip) | 14 KB | 25 KB |
| Kebocoran setelah 40 kali buka-tutup app | +3 KB heap, dokumen & proses kembali | 16 KB |

## Arsitektur

```
index.html ─ shell (desktop + taskbar)              src/shell/
             kernel: proses, jendela, syscall        src/kernel/kernel.js
             filesystem: OPFS → fallback IndexedDB   src/kernel/fs.js
  └─ setiap app = <iframe sandbox="allow-scripts">  src/apps/*.html
       └─ SDK `hawpiw.*` → postMessage → kernel cek izin → jawab
```

- **Isolasi**: app tidak punya `allow-same-origin`, jadi tidak bisa menyentuh DOM shell,
  storage, atau cookie. Satu-satunya jalan keluar adalah syscall.
- **Izin per app** (di `src/apps/registry.js`): `fs` (berkas) dan `launch` (membuka app lain).
- **Filesystem**: OPFS bila ada; selain itu IndexedDB (Safari, atau file dibuka dari `file://`).

## Riset: proyek open-source yang dipelajari

| Proyek | ★ | Lisensi | Pendekatan | Yang diambil |
|---|---|---|---|---|
| [HeyPuter/puter](https://github.com/HeyPuter/puter) | 44k | AGPL-3.0 | Cloud OS, butuh backend; app memakai SDK `puter.js` | Pola **SDK di app + broker di shell** (tanpa kode, karena AGPL & butuh server) |
| [DustinBrett/daedalOS](https://github.com/DustinBrett/daedalOS) | 13k | MIT | Next.js + React, BrowserFS, banyak WASM | Ide app WASM nanti; terlalu berat untuk target "ringan" |
| [runnova/NovaOS](https://github.com/runnova/NovaOS) | 50 | GPL-3.0 | Vanilla JS, tanpa backend, PWA, sistem izin | Validasi visi "tanpa framework, local-first" + **izin per app** |
| [TiddlyWiki5](https://github.com/TiddlyWiki/TiddlyWiki5) | 8.7k | BSD | Satu file HTML yang bisa menyimpan dirinya sendiri | Model distribusi **satu file** |
| [incyashraj/krate](https://github.com/incyashraj/krate) | 27 | MIT/Apache | App = satu file WASM ber-sandbox (Wasmtime), jalan di browser & native | Arah format app fase 3 |
| [OS.js](https://github.com/os-js/OS.js) | 7k | BSD | Web desktop klasik | Tidak aktif sejak 2022, dilewati |
| [copy/v86](https://github.com/copy/v86), [leaningtech/webvm](https://github.com/leaningtech/webvm) | 24k / 17k | BSD / Apache | Emulasi x86/Linux di browser | Kandidat **app opsional**, bukan pondasi (lambat & besar) |
| [cage-kiosk/cage](https://github.com/cage-kiosk/cage), [Igalia/cog](https://github.com/Igalia/cog) | 2.1k / 354 | MIT | Kompositor kiosk Wayland / peluncur WPE WebKit | Fase 2: boot di hardware |

### Library yang dipakai (bukan ditulis ulang)
- [WinBox.js](https://github.com/nextapps-de/winbox) (Apache-2.0): window manager (drag, resize, minimize, maximize).
- [idb-keyval](https://github.com/jakearchibald/idb-keyval) (Apache-2.0): backend IndexedDB.
- [vite-plugin-singlefile](https://github.com/richardtallent/vite-plugin-singlefile) (MIT): build menjadi satu file.

Sengaja **tidak** dipakai: ZenFS (108 KB gzip & LGPL, lebih besar dari seluruh OS ini;
dipertimbangkan lagi bila app WASI butuh API POSIX).

## Roadmap

1. **Fase 1: web (sekarang)**
   - [x] Shell, kernel syscall, sandbox, izin, filesystem, Berkas/Catatan/Terminal
   - [ ] PWA + Service Worker ([vite-plugin-pwa](https://github.com/vite-pwa/vite-plugin-pwa)) untuk versi hosted
   - [ ] Ekspor/impor seluruh data (backup), karena storage browser bisa dihapus
   - [ ] Sinkron P2P antar perangkat: [Yjs](https://github.com/yjs/yjs) + [y-webrtc](https://github.com/yjs/y-webrtc) + y-indexeddb
   - [ ] App WASI: [@bjorn3/browser_wasi_shim](https://github.com/bjorn3/browser_wasi_shim)
2. **Fase 2: boot di laptop bekas.** Linux minimal + Cage (kiosk) + browser, membuka Hawpiw OS lokal.
   *Masukan, bukan kewajiban:* Alpine Linux punya paket `cage` (edge) dan ukurannya kecil;
   tetapi `cog`/WPE WebKit tidak tersedia di Alpine, jadi pilihannya Alpine + Chromium/Firefox,
   atau Debian + Cog (WPE, lebih hemat RAM). Contoh pendekatan Debian:
   [onurbaydas/karakulak](https://github.com/onurbaydas/karakulak).
3. **Fase 3: format app setara komponen WASI.** App yang sama jalan di browser, ISO, dan server.

## Lisensi

Hawpiw OS berlisensi **GNU General Public License v3.0 atau yang lebih baru**
(`GPL-3.0-or-later`); lihat [LICENSE](LICENSE). Anda bebas memakai, mengubah, dan
mendistribusikan ulang, asalkan versi turunannya juga dirilis dengan lisensi yang sama
beserta kode sumbernya.

Komponen pihak ketiga (WinBox.js, idb-keyval) berlisensi Apache-2.0, yang kompatibel
dengan GPLv3. Setiap build menyertakan `THIRD-PARTY-LICENSES.txt`.
