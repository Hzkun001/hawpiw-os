// Kernel Hawpiw OS: menjalankan aplikasi di iframe ber-sandbox dan melayani "syscall"
// lewat postMessage. Polanya mengikuti puter.js (SDK di sisi app + broker di shell)
// dan sistem izin per-aplikasi ala NovaOS.
import WinBox from 'winbox/src/js/winbox.js';
import sdkSrc from '../sdk/hawpiw-sdk.js?raw';
import appCss from '../sdk/app.css?raw';
import { measure } from './metrics.js';

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
  'sys.info':  { run: (k) => ({ fsBackend: k.fs.backend, processes: k.procs.size, apps: k.apps.size }) },
};

// JSON aman untuk disisipkan di dalam <script>.
const safeJson = (v) => JSON.stringify(v ?? {}).replace(/</g, '\\u003c');

function buildDoc(app, args) {
  const inject = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<style>${appCss}</style><script>window.HAWPIW_ARGS=${safeJson(args)};${sdkSrc}</script>`;
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

    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', SANDBOX);
    frame.className = 'app-frame';
    // Titik ukur performa: dari launch() sampai dokumen app selesai dimuat
    // (script app sudah jalan). Dibaca oleh tests/perf.mjs.
    frame.addEventListener('load', () => measure(`hawpiw:launch:${app.id}`, t0, { pid }), { once: true });
    frame.srcdoc = buildDoc(app, args);

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

    const proc = { pid, app, win, frame, perms: new Set(app.permissions ?? []) };
    this.procs.set(frame.contentWindow, proc);
    this.#changed();
    return proc;
  }

  #changed() { this.dispatchEvent(new Event('change')); }

  async #onMessage(e) {
    const proc = this.procs.get(e.source);
    const msg = e.data;
    if (!proc || !msg || msg.hawpiw !== 1 || typeof msg.call !== 'string') return;

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
