import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

// Minifier membuang komentar lisensi pihak ketiga. Plugin ini memastikan setiap
// distribusi tetap membawa pemberitahuan lisensi (kewajiban Apache-2.0 & GPL):
// komentar di awal index.html + berkas THIRD-PARTY-LICENSES.txt lengkap.
function licenseNotices() {
  const deps = Object.keys(pkg.dependencies ?? {}).map((name) => {
    const dir = `node_modules/${name}`;
    const meta = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
    const file = readdirSync(dir).find((f) => /^licen[cs]e/i.test(f));
    if (!file) throw new Error(`Berkas lisensi tidak ditemukan untuk ${name}`);
    return { name, version: meta.version, license: meta.license, author: meta.author, text: readFileSync(`${dir}/${file}`, 'utf8') };
  });
  const author = (a) => (typeof a === 'string' ? a : a?.name) ?? 'tidak diketahui';

  return {
    name: 'hawpiw-license-notices',
    transformIndexHtml: {
      order: 'post',
      handler: (html) => html.replace(/^<!doctype html>/i, (d) => `${d}\n<!--
  Hawpiw OS ${pkg.version} - ${pkg.repository.url.replace(/^git\+|\.git$/g, '')}
  Hak cipta (C) 2026 kontributor Hawpiw OS. Berlisensi ${pkg.license}.
  Kode sumber lengkap tersedia di repositori di atas.

  Berkas ini memuat komponen pihak ketiga:
${deps.map((d) => `    ${d.name} ${d.version} (${d.license}) oleh ${author(d.author)}`).join('\n')}
  Teks lisensi lengkap: THIRD-PARTY-LICENSES.txt
-->`),
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'THIRD-PARTY-LICENSES.txt',
        source: deps.map((d) => `${'='.repeat(72)}\n${d.name} ${d.version} (${d.license})\n${'='.repeat(72)}\n\n${d.text.trim()}\n`).join('\n'),
      });
    },
  };
}

// CSP halaman utama, dihitung setelah semua JS/CSS ter-inline (karena itu
// berjalan setelah viteSingleFile). Hanya skrip & style yang hash-nya dikenal
// boleh jalan. Dokumen app (srcdoc) MEWARISI kebijakan ini, jadi skrip app dan
// SDK yang disisipkan kernel ikut di-hash dari sumbernya. Hanya untuk build;
// mode dev tetap mengandalkan CSP per app di kernel.
const sha256 = (text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
const blocks = (html, tag) => [...html.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi'))].map((m) => m[1]);

function contentSecurityPolicy() {
  return {
    name: 'hawpiw-csp',
    apply: 'build',
    enforce: 'post',
    // order 'post' + diletakkan setelah viteSingleFile di daftar plugin: harus
    // berjalan SETELAH JS/CSS di-inline, kalau tidak hash skrip utama salah.
    generateBundle: { order: 'post', handler(_, bundle) {
      const asset = bundle['index.html'];
      const page = typeof asset.source === 'string' ? asset.source : Buffer.from(asset.source).toString('utf8');
      const apps = readdirSync('src/apps').filter((f) => f.endsWith('.html')).map((f) => readFileSync(`src/apps/${f}`, 'utf8'));
      const pageWithoutScripts = page.replace(/<script\b[\s\S]*?<\/script>/gi, '');
      const scripts = [...blocks(page, 'script'), ...apps.flatMap((h) => blocks(h, 'script')), readFileSync('src/sdk/hawpiw-sdk.js', 'utf8')];
      const styles = [...blocks(pageWithoutScripts, 'style'), ...apps.flatMap((h) => blocks(h, 'style')), readFileSync('src/sdk/app.css', 'utf8')];
      const list = (xs) => [...new Set(xs.map(sha256))].join(' ');
      const policy = [
        "default-src 'none'",
        `script-src ${list(scripts)}`,
        `style-src ${list(styles)}`,
        'img-src data: blob:',
        'font-src data:',
        'media-src data: blob:',
        "base-uri 'none'",
        "form-action 'none'",
        "object-src 'none'",
      ].join('; ');
      const charset = /<meta charset="utf-8">/i;
      if (!charset.test(page)) throw new Error('hawpiw-csp: <meta charset> tidak ditemukan di index.html');
      // Setelah <meta charset> agar charset tetap di 1024 byte pertama.
      // Pengaman: setiap blok skrip/style di halaman harus tercakup kebijakan.
      const missing = [...blocks(page, 'script'), ...blocks(pageWithoutScripts, 'style')].filter((b) => !b.trim() || !policy.includes(sha256(b)));
      if (missing.length) throw new Error(`hawpiw-csp: ${missing.length} blok inline kosong/tidak ter-hash (JS belum di-inline?)`);
      asset.source = page.replace(charset, (m) => `${m}\n  <meta http-equiv="Content-Security-Policy" content="${policy}">`);
      this.info(`CSP: ${scripts.length} skrip, ${styles.length} style di-hash`);
    } },
  };
}

// Hasil build = dist/index.html (satu file, semua JS/CSS/app ter-inline)
// + THIRD-PARTY-LICENSES.txt + berkas dari public/ (mis. _headers Cloudflare).
export default defineConfig({
  plugins: [viteSingleFile(), licenseNotices(), contentSecurityPolicy()],
  define: { __HAWPIW_VERSION__: JSON.stringify(pkg.version) },
  build: { target: 'es2022' },
});
