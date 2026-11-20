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

// Hasil build = dist/index.html (satu file, semua JS/CSS/app ter-inline)
// + THIRD-PARTY-LICENSES.txt + berkas dari public/ (mis. _headers Cloudflare).
export default defineConfig({
  plugins: [viteSingleFile(), licenseNotices()],
  define: { __HAWPIW_VERSION__: JSON.stringify(pkg.version) },
  build: { target: 'es2022' },
});
