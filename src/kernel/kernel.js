// Kernel Hawpiw OS: menjalankan aplikasi di iframe ber-sandbox dan melayani "syscall"
// lewat postMessage. Polanya mengikuti puter.js (SDK di sisi app + broker di shell)
// dan sistem izin per-aplikasi ala NovaOS.
import WinBox from 'winbox/src/js/winbox.js';
import sdkSrc from '../sdk/hawpiw-sdk.js?raw';
import appCss from '../sdk/app.css?raw';
import { measure } from './metrics.js';
// Modul cadangan (termasuk fflate) dimuat saat pertama dipakai, bukan saat boot:
// fflate membangun tabel kompresi ketika dievaluasi, dan biaya itu (+15% boot,
// +5 MB RAM) tidak layak dibayar setiap boot untuk fitur yang jarang dipakai.
const loadBackup = () => import('./backup.js');

const VERSION = __HAWPIW_VERSION__; // diisi Vite dari package.json

// Unduhan dipicu dari dokumen utama: iframe app tidak punya allow-downloads.
function download(bytes, filename, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

// Tanpa allow-same-origin: app mendapat origin "opaque", tidak bisa menyentuh
// DOM shell, storage, atau cookie. Satu-satunya jalan keluar adalah syscall.
const SANDBOX = 'allow-scripts allow-modals';

const SYSCALLS = {
  'fs.list':   { perm: 'fs', run: (k, p, [path]) => k.fs.list(path) },
  'fs.read':   { perm: 'fs', run: (k, p, [path]) => k.fs.read(path) },
  'fs.write':  { perm: 'fs', run: (k, p, [path, text]) => k.fs.write(path, text) },
  'fs.mkdir':  { perm: 'fs', run: (k, p, [path]) => k.fs.mkdir(path) },
  'fs.remove': { perm: 'fs', run: (k, p, [path]) => k.fs.remove(path) },
  'app.list':  { run: (k) => k.listApps() },
  'app.launch': { perm: 'launch', run: (k, p, [id, args]) => k.launch(id, args).pid },
  'win.setTitle': { run: (k, p, [title]) => { p.win.setTitle(`${p.app.icon} ${String(title).slice(0, 80)}`); } },
  'proc.exit': { run: (k, p) => { p.win.close(); } },
  'sys.info':  { run: (k) => ({ version: VERSION, fsBackend: k.fs.backend, processes: k.procs.size, apps: k.apps.size }) },
  'backup.export': {
    perm: 'backup',
    run: async (k) => {
      const { exportBackup } = await loadBackup();
      const r = await exportBackup(k.fs, VERSION);
      download(r.bytes, `hawpiw-cadangan-${stamp()}.zip`, 'application/zip');
      return { files: r.files, dirs: r.dirs, bytes: r.bytes.length };
    },
  },
  'backup.import': {
    perm: 'backup',
    run: async (k, p, [data, mode]) => {
      if (!(data instanceof ArrayBuffer)) throw new Error('Data cadangan harus berupa ArrayBuffer');
      const { restoreBackup } = await loadBackup();
      return restoreBackup(k.fs, data, mode, VERSION);
    },
  },
};

// CSP setiap dokumen app: tidak ada jaringan sama sekali (fetch, gambar, font,
// media dari luar, form), sehingga app tidak bisa mengirim data ke luar.
// Di build produksi, CSP halaman utama (diwarisi dokumen srcdoc) mempersempit
// script-src/style-src lagi menjadi hash kode yang dikenal saja.
// Sisa risiko yang TIDAK bisa ditutup CSP: WebRTC, dan app yang berpindah
// halaman (URL tujuan bisa membawa data). Yang kedua dibatasi: app yang
// berpindah halaman langsung ditutup (lihat launch()). Lihat README > Keamanan.
const APP_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const attr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Token instans: rahasia per proses, wajib ada di setiap syscall. Pesan dari
// dokumen lain di frame yang sama (mis. setelah app berpindah halaman) tidak
// tahu token ini. Pola yang sama dipakai Puter (appInstanceID).
// getRandomValues dipakai karena randomUUID butuh secure context.
function newToken() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// Data per proses (token, argumen) dikirim lewat <meta>, bukan <script>,
// supaya semua skrip di dokumen app statis dan bisa di-hash untuk CSP.
function buildDoc(app, boot) {
  const inject = '<meta charset="utf-8">'
    + `<meta http-equiv="Content-Security-Policy" content="${APP_CSP}">`
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<meta name="hawpiw-boot" content="${attr(JSON.stringify(boot))}">`
    + `<style>${appCss}</style><script>${sdkSrc}</script>`;
  return app.html.replace(/<head>/i, `<head>${inject}`);
}

export class Kernel extends EventTarget {
  procs = new Map(); // WindowProxy iframe -> proses
  #nextPid = 1;

  constructor({ fs, apps }) {
    super();
    this.fs = fs;
    this.apps = new Map(apps.map((a) => [a.id, a]));
    window.addEventListener('message', (e) => this.#onMessage(e));
  }

  listApps() {
    return [...this.apps.values()].map(({ id, name, icon }) => ({ id, name, icon }));
  }

  launch(appId, args = {}) {
    const app = this.apps.get(appId);
    if (!app) throw new Error(`Aplikasi tidak dikenal: ${appId}`);
    const t0 = performance.now();
    const pid = this.#nextPid++;
    const token = newToken();

    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', SANDBOX);
    frame.className = 'app-frame';
    // Titik ukur performa: dari launch() sampai dokumen app selesai dimuat
    // (script app sudah jalan). Dibaca oleh tests/perf.mjs.
    let loads = 0;
    frame.addEventListener('load', () => {
      if (++loads === 1) return measure(`hawpiw:launch:${app.id}`, t0, { pid });
      // Dokumen kedua di frame ini = app berpindah halaman. Halaman baru bukan
      // app yang kita jalankan, jadi prosesnya dihentikan.
      console.warn(`[hawpiw] ${app.name} berpindah halaman; proses ${pid} dihentikan`);
      proc.win.close();
    });
    frame.srcdoc = buildDoc(app, { token, args });

    const narrow = window.innerWidth < 700;
    const offset = (this.procs.size % 6) * 28;
    const win = new WinBox({
      title: `${app.icon} ${app.name}`,
      root: document.getElementById('windows'),
      mount: frame,
      width: Math.min(app.width ?? 640, window.innerWidth - 16),
      height: Math.min(app.height ?? 440, window.innerHeight - 64),
      x: narrow ? 0 : 128 + offset, // sisakan kolom ikon desktop
      y: narrow ? 0 : 24 + offset,
      bottom: 48, // ruang untuk taskbar
      class: ['hawpiw-win'],
      onfocus: () => this.#changed(),
      onminimize: () => this.#changed(),
      onrestore: () => this.#changed(),
      onclose: () => {
        this.procs.delete(frame.contentWindow);
        queueMicrotask(() => this.#changed());
      },
    });
    if (narrow) win.maximize();

    const proc = { pid, token, app, win, frame, perms: new Set(app.permissions ?? []) };
    this.procs.set(frame.contentWindow, proc);
    this.#changed();
    return proc;
  }

  #changed() { this.dispatchEvent(new Event('change')); }

  async #onMessage(e) {
    const proc = this.procs.get(e.source);
    const msg = e.data;
    // Hanya dokumen app asli (punya token instansnya) yang boleh memanggil syscall.
    if (!proc || !msg || msg.hawpiw !== 1 || msg.token !== proc.token || typeof msg.call !== 'string') return;

    const reply = (body) => e.source.postMessage({ hawpiw: 1, id: msg.id, ...body }, '*');
    const sc = Object.hasOwn(SYSCALLS, msg.call) ? SYSCALLS[msg.call] : null;
    if (!sc) return reply({ ok: false, error: `Syscall tidak dikenal: ${msg.call}` });
    if (sc.perm && !proc.perms.has(sc.perm)) {
      return reply({ ok: false, error: `Izin "${sc.perm}" tidak dimiliki ${proc.app.name}` });
    }
    try {
      const args = Array.isArray(msg.args) ? msg.args : [];
      reply({ ok: true, result: await sc.run(this, proc, args) });
    } catch (err) {
      reply({ ok: false, error: err?.message ?? String(err) });
    }
  }
}
