// Cadangan (ekspor/impor) seluruh filesystem sebagai satu file .zip.
// Penyimpanan browser bisa hilang (cache dibersihkan, mode privat, kuota),
// jadi pengguna harus bisa menyimpan datanya ke luar browser.
//
// Isi zip:
//   hawpiw-backup.json   manifest: format, versi, waktu, ukuran setiap berkas
//   files/<path>         isi filesystem (folder kosong ikut disimpan)
//
// Impor memvalidasi SELURUH isi zip sebelum mengubah apa pun. Mode "replace"
// membuat salinan pengaman di memori dulu dan memulihkannya bila penulisan gagal.
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { split, join, FsError } from './fs.js';

export const MANIFEST = 'hawpiw-backup.json';
const FORMAT = 1;
const PREFIX = 'files/';
export const LIMITS = {
  zipBytes: 100 * 1024 * 1024,   // ukuran file .zip
  totalBytes: 200 * 1024 * 1024, // total setelah dekompresi (perlindungan zip bomb)
  entries: 10_000,
};
// Karakter yang ditolak OPFS/sistem berkas; ditolak saat validasi supaya
// impor tidak gagal di tengah jalan.
const BAD_SEGMENT = /[\\\u0000-\u001f]/;

async function walk(fs, dir, out) {
  for (const it of await fs.list(dir)) {
    const path = join([...split(dir), it.name]);
    if (it.type === 'dir') {
      out.push({ type: 'dir', path });
      await walk(fs, path, out);
    } else {
      out.push({ type: 'file', path, text: await fs.read(path) });
    }
  }
  return out;
}

/** @returns {{ bytes: Uint8Array, files: number, dirs: number }} */
export async function exportBackup(fs, version) {
  const entries = await walk(fs, '/', []);
  const zippable = {};
  const sizes = {};
  for (const e of entries) {
    const key = PREFIX + e.path.slice(1);
    if (e.type === 'dir') {
      zippable[key] = {};
    } else {
      const data = strToU8(e.text);
      zippable[key] = data;
      sizes[e.path] = data.length;
    }
  }
  const manifest = {
    app: 'hawpiw-os',
    format: FORMAT,
    version,
    created: new Date().toISOString(),
    files: sizes,
  };
  zippable[MANIFEST] = strToU8(JSON.stringify(manifest, null, 2));
  return {
    bytes: zipSync(zippable, { level: 6 }),
    files: Object.keys(sizes).length,
    dirs: entries.length - Object.keys(sizes).length,
  };
}

/** Membaca dan memvalidasi cadangan tanpa menyentuh filesystem. */
export function readBackup(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length > LIMITS.zipBytes) throw new FsError('File cadangan terlalu besar (maks 100 MB)');

  let count = 0;
  let total = 0;
  let raw;
  try {
    raw = unzipSync(bytes, {
      filter: (f) => {
        if (++count > LIMITS.entries) throw new FsError('Cadangan berisi terlalu banyak entri');
        total += f.originalSize;
        if (total > LIMITS.totalBytes) throw new FsError('Isi cadangan terlalu besar setelah dibuka (maks 200 MB)');
        return true;
      },
    });
  } catch (err) {
    throw err instanceof FsError ? err : new FsError('Bukan file .zip yang valid');
  }

  if (!raw[MANIFEST]) throw new FsError('Bukan cadangan Hawpiw OS (manifest tidak ditemukan)');
  let manifest;
  try { manifest = JSON.parse(strFromU8(raw[MANIFEST])); } catch { throw new FsError('Manifest cadangan rusak'); }
  if (manifest?.app !== 'hawpiw-os') throw new FsError('Bukan cadangan Hawpiw OS');
  if (manifest.format !== FORMAT) throw new FsError(`Format cadangan ${manifest.format} tidak didukung`);
  const sizes = manifest.files && typeof manifest.files === 'object' ? manifest.files : {};

  const entries = [];
  for (const [name, data] of Object.entries(raw)) {
    if (name === MANIFEST) continue;
    if (!name.startsWith(PREFIX)) throw new FsError(`Entri tidak dikenal di cadangan: ${name}`);
    const segs = split(name.slice(PREFIX.length)); // menolak ".." (zip slip)
    if (!segs.length) continue;
    const bad = segs.find((s) => BAD_SEGMENT.test(s) || s.length > 255);
    if (bad !== undefined) throw new FsError(`Nama berkas tidak valid di cadangan: ${name}`);
    const path = join(segs);
    if (name.endsWith('/')) {
      entries.push({ type: 'dir', path });
    } else {
      if (sizes[path] !== data.length) throw new FsError(`Berkas rusak atau tidak cocok dengan manifest: ${path}`);
      entries.push({ type: 'file', path, text: strFromU8(data) });
    }
  }
  const present = new Set(entries.filter((e) => e.type === 'file').map((e) => e.path));
  const missing = Object.keys(sizes).find((p) => !present.has(p));
  if (missing) throw new FsError(`Berkas hilang dari cadangan: ${missing}`);

  return { manifest, entries };
}

async function clear(fs) {
  for (const it of await fs.list('/')) await fs.remove('/' + it.name);
}

async function apply(fs, entries) {
  // Folder dulu (urut dari yang dangkal), baru berkas.
  for (const e of entries.filter((x) => x.type === 'dir').sort((a, b) => a.path.length - b.path.length)) await fs.mkdir(e.path);
  for (const e of entries.filter((x) => x.type === 'file')) await fs.write(e.path, e.text);
}

/**
 * @param {'merge'|'replace'} mode merge = timpa berkas bernama sama, sisanya dibiarkan;
 *                                 replace = hapus semua data sekarang lalu pulihkan.
 */
export async function restoreBackup(fs, input, mode, version) {
  if (mode !== 'merge' && mode !== 'replace') throw new FsError(`Mode impor tidak dikenal: ${mode}`);
  const { manifest, entries } = readBackup(input);

  if (mode === 'replace') {
    const safety = readBackup((await exportBackup(fs, version)).bytes).entries;
    try {
      await clear(fs);
      await apply(fs, entries);
    } catch (err) {
      await clear(fs).catch(() => {});
      await apply(fs, safety).catch(() => {});
      throw new FsError(`Impor gagal, data lama sudah dikembalikan: ${err.message}`);
    }
  } else {
    await apply(fs, entries);
  }
  const files = entries.filter((e) => e.type === 'file').length;
  return { files, dirs: entries.length - files, created: manifest.created, version: manifest.version };
}
