// Uji end-to-end Hawpiw OS: node tests/e2e.mjs <url> <chromium|firefox|webkit> [screenshotDir]
// CHROMIUM_PATH bisa diisi bila Chromium bawaan Playwright tidak terpasang.
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, firefox, webkit } from 'playwright-core';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';

const [url, which = 'chromium', shotDir] = process.argv.slice(2);
const engines = { chromium, firefox, webkit };
const opts = which === 'chromium'
  && process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};

let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  [${which}] ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failed++;
};

const browser = await engines[which].launch(opts);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => logs.push(m.text()));
page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));

await page.goto(url);
await page.waitForSelector('.icon');
check('4 ikon app tampil', (await page.locator('.icon').count()) === 4);
const bootLog = logs.find((l) => l.startsWith('[hawpiw] boot')) ?? '';
check('boot tercatat', !!bootLog, bootLog);

// Terminal
await page.locator('.icon', { hasText: 'Terminal' }).click();
const term = page.frameLocator('.winbox iframe').last();
const input = term.locator('#in');
await input.waitFor();
const run = async (cmd) => { await input.fill(cmd); await input.press('Enter'); await page.waitForTimeout(150); };
await run('ls');
check('ls menampilkan file sambutan', (await term.locator('#out').innerText()).includes('selamat-datang.txt'));
await run('echo halo dunia > tes.txt');
await run('cat tes.txt');
check('echo + cat ke filesystem', (await term.locator('#out').innerText()).includes('halo dunia'));
await run('cat /tidak/ada.txt');
check('error file tidak ada tampil', (await term.locator('.err').count()) >= 1);

// Keamanan sandbox (dievaluasi dari dalam iframe app)
const termFrame = page.frames().find((f) => f !== page.mainFrame() && f.url() === 'about:srcdoc');
const sec = await termFrame.evaluate(async () => {
  const r = {};
  try { void parent.document.body; r.parentDom = 'TERBUKA'; } catch { r.parentDom = 'diblokir'; }
  try { localStorage.getItem('x'); r.storage = 'TERBUKA'; } catch { r.storage = 'diblokir'; }
  try { await hawpiw.fs.read('/home/../etc'); r.dotdot = 'LOLOS'; } catch (e) { r.dotdot = e.message; }
  try { await hawpiw.fs.remove('/'); r.rmRoot = 'LOLOS'; } catch (e) { r.rmRoot = e.message; }
  return r;
});
check('app tidak bisa akses DOM shell', sec.parentDom === 'diblokir');
check('app tidak bisa akses storage sendiri', sec.storage === 'diblokir');
check('path ".." ditolak', sec.dotdot.includes('..'), sec.dotdot);
check('hapus root ditolak', sec.rmRoot !== 'LOLOS', sec.rmRoot);

// Berkas -> buka file di Catatan (izin launch)
await page.locator('.icon', { hasText: 'Berkas' }).click();
const files = page.frameLocator('.winbox iframe').last();
await files.locator('li', { hasText: 'tes.txt' }).dblclick();
const notes = page.frameLocator('.winbox iframe').last();
await page.waitForTimeout(400);
check('Catatan membuka tes.txt', (await notes.locator('#text').inputValue()).includes('halo dunia'));
await notes.locator('#text').fill('diubah lewat Catatan');
await notes.locator('#text').press('Control+s');
await page.waitForTimeout(300);
check('Ctrl+S menyimpan', (await notes.locator('#status').innerText()) === 'tersimpan');

// Izin: Catatan tidak punya "launch"
const notesFrame = page.frames().filter((f) => f.url() === 'about:srcdoc').at(-1);
const denied = await notesFrame.evaluate(() => hawpiw.app.launch('files').then(() => 'LOLOS', (e) => e.message));
check('izin launch ditolak untuk Catatan', denied.includes('Izin'), denied);
const deniedBackup = await notesFrame.evaluate(() => hawpiw.backup.export().then(() => 'LOLOS', (e) => e.message));
check('izin backup ditolak untuk Catatan', deniedBackup.includes('Izin'), deniedBackup);

check('taskbar menampilkan 3 jendela', (await page.locator('.task').count()) === 3);
if (shotDir) await page.screenshot({ path: `${shotDir}/desktop-${which}.png` });

// Persistensi setelah reload
await page.reload();
await page.waitForSelector('.icon');
const persisted = await page.evaluate(() => window.hawpiwKernel.fs.read('/home/tes.txt'));
check('data bertahan setelah reload', persisted === 'diubah lewat Catatan', JSON.stringify(persisted));

// ---------- Cadangan: ekspor ----------
const work = mkdtempSync(join(tmpdir(), 'hawpiw-e2e-'));
await page.locator('.icon', { hasText: 'Cadangan' }).click();
const bk = page.frameLocator('.winbox iframe').last();
const [dl] = await Promise.all([page.waitForEvent('download'), bk.locator('#export').click()]);
const zipPath = join(work, dl.suggestedFilename());
await dl.saveAs(zipPath);
await bk.locator('#exportResult.ok').waitFor();
check('nama file cadangan bertanggal', /^hawpiw-cadangan-\d{4}-\d{2}-\d{2}-\d{4}\.zip$/.test(dl.suggestedFilename()), dl.suggestedFilename());
const zipped = unzipSync(readFileSync(zipPath));
const man = JSON.parse(strFromU8(zipped['hawpiw-backup.json']));
check('zip berisi manifest & berkas', man.app === 'hawpiw-os' && strFromU8(zipped['files/home/tes.txt']) === 'diubah lewat Catatan',
  Object.keys(zipped).join(', '));

// ---------- Cadangan: impor ke browser bersih ----------
const c2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const p2 = await c2.newPage();
p2.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));
await p2.goto(url);
await p2.waitForSelector('.icon');
await p2.locator('.icon', { hasText: 'Cadangan' }).click();
const b2 = p2.frameLocator('.winbox iframe').last();
const fs2 = {
  list: (d) => p2.evaluate((d) => window.hawpiwKernel.fs.list(d), d),
  read: (f) => p2.evaluate((f) => window.hawpiwKernel.fs.read(f).catch(() => null), f),
  write: (f, t) => p2.evaluate(([f, t]) => window.hawpiwKernel.fs.write(f, t), [f, t]),
};
const snapshot = async () => JSON.stringify([await fs2.list('/'), await fs2.list('/home')]);
async function restore(file, mode = 'merge') {
  const [chooser] = await Promise.all([p2.waitForEvent('filechooser'), b2.locator('#file').click()]);
  await chooser.setFiles(file);
  await b2.locator(`input[name=mode][value=${mode}]`).check();
  if (mode === 'replace') p2.once('dialog', (d) => d.accept());
  await b2.locator('#import').click();
  await b2.locator('#importResult.ok, #importResult.err').waitFor();
  return { ok: await b2.locator('#importResult.ok').count() === 1, text: await b2.locator('#importResult').innerText() };
}

let r = await restore(zipPath);
check('impor (gabungkan) memulihkan berkas', r.ok && (await fs2.read('/home/tes.txt')) === 'diubah lewat Catatan', r.text);

await fs2.write('/ekstra.txt', 'harus hilang');
r = await restore(zipPath, 'replace');
check('impor (ganti semua) menghapus data lain', r.ok && (await fs2.read('/ekstra.txt')) === null
  && (await fs2.read('/home/tes.txt')) === 'diubah lewat Catatan', r.text);

// Cadangan berbahaya/rusak: harus ditolak tanpa mengubah apa pun.
const manifestFor = (files) => strToU8(JSON.stringify({ app: 'hawpiw-os', format: 1, files }));
const bad = {
  'zip slip (../)': zipSync({ 'hawpiw-backup.json': manifestFor({ '/evil.txt': 5 }), 'files/../evil.txt': strToU8('jahat') }),
  'tanpa manifest': zipSync({ 'files/a.txt': strToU8('x') }),
  'bukan zip': strToU8('ini bukan zip sama sekali'),
  'ukuran tidak cocok manifest': zipSync({ 'hawpiw-backup.json': manifestFor({ '/a.txt': 3 }), 'files/a.txt': strToU8('lima!') }),
  'berkas hilang dari zip': zipSync({ 'hawpiw-backup.json': manifestFor({ '/a.txt': 1, '/b.txt': 1 }), 'files/a.txt': strToU8('a') }),
  'format tidak dikenal': zipSync({ 'hawpiw-backup.json': strToU8(JSON.stringify({ app: 'hawpiw-os', format: 99, files: {} })) }),
};
for (const [label, bytes] of Object.entries(bad)) {
  const before = await snapshot();
  r = await restore({ name: 'cadangan.zip', mimeType: 'application/zip', buffer: Buffer.from(bytes) }, 'replace');
  check(`cadangan ditolak: ${label}`, !r.ok && (await snapshot()) === before, r.text);
}

// Mode "ganti semua" gagal di tengah jalan: data lama harus kembali.
await fs2.write('/home/penting.txt', 'jangan hilang');
const beforeFail = await snapshot();
await p2.evaluate(() => {
  const fs = window.hawpiwKernel.fs;
  const orig = fs.write.bind(fs);
  let thrown = false;
  fs.write = (path, text) => {
    if (!thrown && path === '/home/tes.txt') { thrown = true; return Promise.reject(new Error('disk penuh (simulasi)')); }
    return orig(path, text);
  };
});
r = await restore(zipPath, 'replace');
check('ganti semua gagal → data lama dikembalikan', !r.ok && r.text.includes('dikembalikan')
  && (await fs2.read('/home/penting.txt')) === 'jangan hilang' && (await snapshot()) === beforeFail, r.text);
await c2.close();

// Tampilan HP: jendela otomatis maksimal
const m = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true });
const mp = await m.newPage();
await mp.goto(url);
await mp.locator('.icon', { hasText: 'Catatan' }).click();
await mp.waitForTimeout(300);
const box = await mp.locator('.winbox').boundingBox();
check('di layar HP jendela memenuhi lebar', box && box.width >= 380, JSON.stringify(box));
if (shotDir) await mp.screenshot({ path: `${shotDir}/mobile-${which}.png` });

const errs = logs.filter((l) => l.startsWith('PAGEERROR'));
check('tidak ada error JS', errs.length === 0, errs.join(' | '));
await browser.close();
console.log(failed ? `${failed} GAGAL` : 'SEMUA LULUS');
process.exit(failed ? 1 : 0);
