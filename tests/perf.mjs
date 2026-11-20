// Baseline performa runtime (Chromium): node tests/perf.mjs <url> [cpuThrottle=4]
// Mengukur waktu boot pada CPU yang diperlambat (simulasi HP/laptop murah),
// biaya memori tiap app yang dibuka, dan jumlah proses renderer.
import { chromium } from 'playwright-core';

const [url, throttleArg = '4'] = process.argv.slice(2);
const throttle = Number(throttleArg);
const opts = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};
const browser = await chromium.launch(opts);
const bcdp = await browser.newBrowserCDPSession();

const renderers = async () => {
  const { processInfo } = await bcdp.send('SystemInfo.getProcessInfo');
  return processInfo.filter((p) => p.type === 'renderer').length;
};

async function bootRun() {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  await page.goto(url);
  await page.waitForSelector('.icon');
  const t = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    return { fcp: fcp?.startTime, domInteractive: nav.domInteractive, load: nav.loadEventEnd };
  });
  return { ctx, page, cdp, t };
}

const runs = [];
for (let i = 0; i < 5; i++) {
  const r = await bootRun();
  runs.push(r.t);
  if (i < 4) await r.ctx.close();
  else var last = r;
}
const median = (k) => runs.map((r) => r[k]).sort((a, b) => a - b)[2];
console.log(`CPU diperlambat ${throttle}x, median 5 boot:`);
console.log(`  first contentful paint : ${median('fcp').toFixed(0)} ms`);
console.log(`  DOM interaktif         : ${median('domInteractive').toFixed(0)} ms`);

const { page, cdp } = last;
await cdp.send('Performance.enable');
const heap = async () => {
  await cdp.send('HeapProfiler.collectGarbage');
  const { metrics } = await cdp.send('Performance.getMetrics');
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  return { heapMB: m.JSHeapUsedSize / 1048576, docs: m.Documents, frames: m.Frames };
};
const base = await heap();
const r0 = await renderers();
console.log(`Desktop kosong: heap ${base.heapMB.toFixed(2)} MB, frame ${base.frames}, renderer ${r0}`);

for (const name of ['Berkas', 'Catatan', 'Terminal', 'Catatan', 'Catatan']) {
  const t0 = Date.now();
  await page.locator('.icon', { hasText: name }).click();
  await page.frameLocator('.winbox iframe').last().locator('body *').first().waitFor();
  const dt = Date.now() - t0;
  const h = await heap();
  console.log(`+ ${name.padEnd(8)} buka ${String(dt).padStart(4)} ms | heap ${h.heapMB.toFixed(2)} MB | frame ${h.frames} | renderer ${await renderers()}`);
}
await browser.close();
