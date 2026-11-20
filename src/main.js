import 'winbox/dist/css/winbox.min.css';
import './shell/shell.css';
import { createFs } from './kernel/fs.js';
import { Kernel } from './kernel/kernel.js';
import { mountShell } from './shell/desktop.js';
import { apps } from './apps/registry.js';

const WELCOME = `Selamat datang di Hawpiw OS ⚡

Seluruh sistem ini adalah satu file HTML. Tidak ada server:
semua berkas tersimpan di perangkat Anda sendiri.

Coba:
- buka Berkas, klik dua kali sebuah file untuk mengedit
- buka Terminal, ketik "help"
`;

async function boot() {
  const t0 = performance.now();
  const fs = await createFs();
  if ((await fs.list('/')).length === 0) {
    await fs.mkdir('/home');
    await fs.write('/home/selamat-datang.txt', WELCOME);
  }
  const kernel = new Kernel({ fs, apps });
  mountShell(kernel);
  window.hawpiwKernel = kernel; // untuk debugging di DevTools
  console.info(`[hawpiw] boot ${Math.round(performance.now() - t0)} ms · fs=${fs.backend}`);
}

boot().catch((err) => {
  document.body.textContent = `Gagal boot: ${err?.message ?? err}`;
  console.error(err);
});
