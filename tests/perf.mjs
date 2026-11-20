// Pengukuran performa Hawpiw OS yang stabil secara statistik (Chromium).
//
//   node tests/perf.mjs <url> [--samples 15] [--warmup 2] [--throttle 4]
//                             [--budget perf-budget.json] [--json hasil.json]
//
// Metode (meniru google/tachometer yang kini diarsipkan):
// - setiap sampel memakai browser baru, jadi tidak ada cache/JIT yang terbawa;
// - sampel pemanasan dibuang;
// - dilaporkan median, rentang antarkuartil, dan interval kepercayaan 95%
//   median (bootstrap dengan seed tetap, jadi hasilnya bisa diulang);
// - waktu diambil dari performance.measure milik OS sendiri (hawpiw:boot,
//   hawpiw:launch:<app>), bukan dari stopwatch di luar browser;
// - memori = PSS proses renderer dari /proc (Linux), termasuk proses app.
// Keluar dengan kode 1 bila median melewati anggaran di perf-budget.json.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright-core';

const argv = process.argv.slice(2);
const url = argv.find((a) => !a.startsWith('--') && !/^\d/.test(a));
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? def : argv[i + 1];
};
if (!url) {
  console.error('Pakai: node tests/perf.mjs <url> [--samples 15] [--warmup 2] [--throttle 4] [--budget f] [--json f]');
  process.exit(2);
}
const budgetFile = opt('budget', 'perf-budget.json');
const budgetCfg = existsSync(budgetFile) ? JSON.parse(readFileSync(budgetFile, 'utf8')) : {};
const budget = budgetCfg.budgets ?? {};
const SAMPLES = Number(opt('samples', 15));
const WARMUP = Number(opt('warmup', 2));
const THROTTLE = Number(opt('throttle', budgetCfg.throttle ?? 4));
const APPS = [['files', 'Berkas'], ['notes', 'Catatan'], ['terminal', 'Terminal']];
const launchOpts = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};
const hasProc = process.platform === 'linux';

// ---------- statistik ----------
const sorted = (xs) => [...xs].sort((a, b) => a - b);
function quantile(xs, q) {
  const s = sorted(xs);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (pos - lo);
}
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function bootstrapMedianCI(xs, iters = 2000) {
  const rnd = mulberry32(42);
  const meds = [];
  for (let i = 0; i < iters; i++) meds.push(quantile(xs.map(() => xs[Math.floor(rnd() * xs.length)]), 0.5));
  return [quantile(meds, 0.025), quantile(meds, 0.975)];
}
function summarize(xs) {
  const med = quantile(xs, 0.5);
  const [ciLo, ciHi] = bootstrapMedianCI(xs);
  return { n: xs.length, median: med, p25: quantile(xs, 0.25), p75: quantile(xs, 0.75), ciLo, ciHi, ciPct: ((ciHi - ciLo) / 2 / med) * 100 };
}

// ---------- memori (Linux) ----------
function pssKB(pid) {
  try {
    const m = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8').match(/^Pss:\s+(\d+) kB/m);
    return m ? Number(m[1]) : 0;
  } catch { return 0; }
}
async function rendererPss(bcdp) {
  const { processInfo } = await bcdp.send('SystemInfo.getProcessInfo');
  const pids = processInfo.filter((p) => p.type === 'renderer').map((p) => p.id);
  return { count: pids.length, mb: pids.reduce((s, p) => s + pssKB(p), 0) / 1024 };
}

// ---------- satu sampel ----------
async function sample({ index, leakCheck }) {
  const browser = await chromium.launch(launchOpts);
  try {
    const bcdp = await browser.newBrowserCDPSession();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
    await page.goto(url);
    await page.waitForFunction(() => performance.getEntriesByName('hawpiw:boot').length > 0
      && performance.getEntriesByName('first-contentful-paint').length > 0);
    const r = await page.evaluate(() => ({
      boot: performance.getEntriesByName('hawpiw:boot')[0].duration,
      fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? NaN,
    }));
    await page.waitForTimeout(300);
    const idle = hasProc ? await rendererPss(bcdp) : null;

    // Urutan app diputar tiap sampel. App pertama = "cold start" (termasuk
    // membuat proses sandbox baru); app berikutnya = biaya buka app itu sendiri.
    const order = APPS.map((_, j) => APPS[(index + j) % APPS.length]);
    for (const [j, [id, label]] of order.entries()) {
      await page.locator('.icon', { hasText: label }).click();
      await page.waitForFunction((n) => performance.getEntriesByName(n).length > 0, `hawpiw:launch:${id}`);
      const d = await page.evaluate((n) => performance.getEntriesByName(n)[0].duration, `hawpiw:launch:${id}`);
      r[j === 0 ? 'launch_cold' : `launch_${id}`] = d;
    }
    await page.waitForTimeout(500);
    if (hasProc) {
      const busy = await rendererPss(bcdp);
      r.pss_idle_mb = idle.mb;
      r.pss_per_app_mb = (busy.mb - idle.mb) / APPS.length;
    }

    if (leakCheck) {
      // Heap naik ~45 KB sekali saja selama ~25 siklus pertama (JIT "memanas"),
      // lalu datar. Jadi yang diukur kemiringannya: 25 siklus pemanasan, garis
      // dasar, lalu 40 siklus lagi. Kebocoran sungguhan tetap naik di fase ini.
      const cycles = (n) => page.evaluate(async (n) => {
        for (let i = 0; i < n; i++) {
          await new Promise((res) => {
            const p = window.hawpiwKernel.launch('notes');
            p.frame.addEventListener('load', () => { p.win.close(); res(); }, { once: true });
          });
        }
      }, n);
      await page.evaluate(() => [...window.hawpiwKernel.procs.values()].forEach((p) => p.win.close()));
      await cycles(25);
      await page.waitForTimeout(1500);
      const before = await counters(cdp, bcdp);
      await cycles(40);
      await page.evaluate(() => [...window.hawpiwKernel.procs.values()].forEach((p) => p.win.close()));
      await page.waitForTimeout(1500);
      const after = await counters(cdp, bcdp);
      r.leak = { before, after };
    }
    return r;
  } finally {
    await browser.close();
  }
}

async function counters(cdp, bcdp) {
  await cdp.send('HeapProfiler.collectGarbage');
  const dom = await cdp.send('Memory.getDOMCounters');
  const { usedSize } = await cdp.send('Runtime.getHeapUsage');
  const procs = hasProc ? (await rendererPss(bcdp)).count : NaN;
  const procsOpen = await cdp.send('Runtime.evaluate', { expression: 'window.hawpiwKernel.procs.size', returnByValue: true });
  return { documents: dom.documents, nodes: dom.nodes, listeners: dom.jsEventListeners, heapKB: usedSize / 1024, renderers: procs, openApps: procsOpen.result.value };
}

// ---------- jalankan ----------
console.log(`Hawpiw OS perf · ${url}`);
console.log(`CPU diperlambat ${THROTTLE}x · ${SAMPLES} sampel (+${WARMUP} pemanasan dibuang) · browser baru per sampel\n`);

const res = await fetch(url, { headers: { 'accept-encoding': 'identity' } });
const html = Buffer.from(await res.arrayBuffer());
const sizeGzipKB = gzipSync(html, { level: 9 }).length / 1024;

const runs = [];
let leak = null;
for (let i = 0; i < WARMUP + SAMPLES; i++) {
  const isLast = i === WARMUP + SAMPLES - 1;
  const r = await sample({ index: i, leakCheck: isLast });
  if (r.leak) { leak = r.leak; delete r.leak; }
  if (i >= WARMUP) runs.push(r);
  process.stdout.write(i < WARMUP ? 'w' : '.');
}
console.log('\n');

const metrics = {
  boot_ms: ['Boot (navigasi → shell siap)', 'ms'],
  fcp_ms: ['First contentful paint', 'ms'],
  launch_cold_ms: ['Buka app pertama (cold start)', 'ms'],
  launch_files_ms: ['Buka Berkas', 'ms'],
  launch_notes_ms: ['Buka Catatan', 'ms'],
  launch_terminal_ms: ['Buka Terminal', 'ms'],
  pss_idle_mb: ['RAM desktop kosong (PSS)', 'MB'],
  pss_per_app_mb: ['RAM tambahan per app (PSS)', 'MB'],
};
const key = (k) => k.replace(/_ms$/, ''); // boot_ms → boot, launch_files_ms → launch_files
const out = { url, throttle: THROTTLE, samples: SAMPLES, size_gzip_kb: sizeGzipKB, metrics: {}, leak };
let fail = 0;
const fmt = (v) => (v >= 100 ? v.toFixed(0) : v.toFixed(1));
const pad = (s, n) => String(s).padStart(n);
console.log(`${'Metrik'.padEnd(30)} ${pad('median', 8)} ${pad('IQR', 15)} ${pad('CI95 median', 17)} ${pad('anggaran', 9)}  status`);
for (const [k, [label, unit]] of Object.entries(metrics)) {
  const xs = runs.map((r) => r[key(k)]).filter((v) => Number.isFinite(v));
  if (!xs.length) continue;
  const s = summarize(xs);
  out.metrics[k] = s;
  const b = budget[k];
  const over = b !== undefined && s.median > b;
  if (over) fail++;
  const status = b === undefined ? '' : over ? 'LEWAT ANGGARAN' : 'ok';
  const noisy = s.ciPct > 10 ? '  (bising ±' + s.ciPct.toFixed(0) + '%)' : '';
  console.log(`${label.padEnd(30)} ${pad(fmt(s.median) + ' ' + unit, 8)} ${pad(fmt(s.p25) + '–' + fmt(s.p75), 15)} ${pad(fmt(s.ciLo) + '–' + fmt(s.ciHi), 17)} ${pad(b ?? '-', 9)}  ${status}${noisy}`);
}
const sizeOver = budget.size_gzip_kb !== undefined && sizeGzipKB > budget.size_gzip_kb;
if (sizeOver) fail++;
console.log(`${'Ukuran index.html (gzip -9)'.padEnd(30)} ${pad(sizeGzipKB.toFixed(1) + ' KB', 8)} ${''.padStart(34)} ${pad(budget.size_gzip_kb ?? '-', 9)}  ${budget.size_gzip_kb === undefined ? '' : sizeOver ? 'LEWAT ANGGARAN' : 'ok'}`);

if (leak) {
  const { before, after } = leak;
  const leakOk = after.openApps === 0 && after.documents <= before.documents && after.renderers <= before.renderers
    && after.heapKB - before.heapKB < (budget.leak_heap_kb ?? 256);
  if (!leakOk) fail++;
  console.log(`\nUji kebocoran (buka-tutup 40 app setelah 25 siklus pemanasan):`);
  console.log(`  dokumen ${before.documents} → ${after.documents} · node DOM ${before.nodes} → ${after.nodes} · listener ${before.listeners} → ${after.listeners}`);
  console.log(`  proses renderer ${before.renderers} → ${after.renderers} · heap JS shell ${before.heapKB.toFixed(0)} → ${after.heapKB.toFixed(0)} KB · ${leakOk ? 'ok' : 'BOCOR'}`);
}

const jsonFile = opt('json');
if (jsonFile) writeFileSync(jsonFile, JSON.stringify(out, null, 2));
console.log(fail ? `\n${fail} metrik melewati anggaran` : '\nSemua metrik dalam anggaran');
process.exit(fail ? 1 : 0);
