// Uji end-to-end Hawpiw OS: node tests/e2e.mjs <url> <chromium|firefox|webkit> [screenshotDir]
// CHROMIUM_PATH bisa diisi bila Chromium bawaan Playwright tidak terpasang.
import { chromium, firefox, webkit } from 'playwright-core';

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
check('3 ikon app tampil', (await page.locator('.icon').count()) === 3);
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

check('taskbar menampilkan 3 jendela', (await page.locator('.task').count()) === 3);
if (shotDir) await page.screenshot({ path: `${shotDir}/desktop-${which}.png` });

// Persistensi setelah reload
await page.reload();
await page.waitForSelector('.icon');
const persisted = await page.evaluate(() => window.hawpiwKernel.fs.read('/home/tes.txt'));
check('data bertahan setelah reload', persisted === 'diubah lewat Catatan', JSON.stringify(persisted));

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
