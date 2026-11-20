// Filesystem Hawpiw OS.
// Backend utama: OPFS (Origin Private File System, API standar browser).
// Fallback: IndexedDB lewat idb-keyval, untuk browser tanpa OPFS writable
// atau saat file HTML dibuka langsung dari disk (file://).
import { createStore, get, set, del, keys } from 'idb-keyval';

export class FsError extends Error {}

/** Ubah path menjadi segmen yang aman. Menolak ".." agar app tidak keluar dari root. */
export function split(path) {
  const segs = [];
  for (const s of String(path ?? '/').split('/')) {
    if (s === '' || s === '.') continue;
    if (s === '..') throw new FsError('Path dengan ".." tidak diizinkan');
    segs.push(s);
  }
  return segs;
}

export const join = (segs) => '/' + segs.join('/');

const byDirThenName = (a, b) =>
  a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1;

function mapDomError(err, path) {
  if (err?.name === 'NotFoundError') return new FsError(`Tidak ditemukan: ${path}`);
  if (err?.name === 'TypeMismatchError') return new FsError(`Jenis tidak cocok (file/folder): ${path}`);
  if (err?.name === 'InvalidModificationError') return new FsError(`Folder tidak kosong: ${path}`);
  return err instanceof Error ? err : new FsError(String(err));
}

class OpfsFs {
  backend = 'opfs';
  constructor(root) { this.root = root; }

  async #dir(segs, create = false) {
    let dir = this.root;
    for (const s of segs) dir = await dir.getDirectoryHandle(s, { create });
    return dir;
  }

  async #wrap(path, fn) {
    try { return await fn(); } catch (err) { throw mapDomError(err, path); }
  }

  list(path = '/') {
    return this.#wrap(path, async () => {
      const dir = await this.#dir(split(path));
      const out = [];
      for await (const [name, h] of dir.entries()) out.push({ name, type: h.kind === 'directory' ? 'dir' : 'file' });
      return out.sort(byDirThenName);
    });
  }

  read(path) {
    return this.#wrap(path, async () => {
      const segs = split(path);
      const name = segs.pop();
      if (!name) throw new FsError('Root bukan file');
      const fh = await (await this.#dir(segs)).getFileHandle(name);
      return (await fh.getFile()).text();
    });
  }

  write(path, text) {
    return this.#wrap(path, async () => {
      const segs = split(path);
      const name = segs.pop();
      if (!name) throw new FsError('Root bukan file');
      const fh = await (await this.#dir(segs, true)).getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(String(text ?? ''));
      await w.close();
    });
  }

  mkdir(path) {
    return this.#wrap(path, async () => { await this.#dir(split(path), true); });
  }

  remove(path) {
    return this.#wrap(path, async () => {
      const segs = split(path);
      const name = segs.pop();
      if (!name) throw new FsError('Root tidak bisa dihapus');
      await (await this.#dir(segs)).removeEntry(name, { recursive: true });
    });
  }
}

class IdbFs {
  backend = 'indexeddb';
  // Kunci = path absolut, nilai = { type: 'file', data } | { type: 'dir' }. Root tersirat.
  store = createStore('hawpiw-os', 'fs');

  async #node(p) { return p === '/' ? { type: 'dir' } : get(p, this.store); }

  async list(path = '/') {
    const p = join(split(path));
    const node = await this.#node(p);
    if (!node) throw new FsError(`Tidak ditemukan: ${p}`);
    if (node.type !== 'dir') throw new FsError(`Bukan folder: ${p}`);
    const prefix = p === '/' ? '/' : p + '/';
    const out = [];
    for (const k of await keys(this.store)) {
      if (!k.startsWith(prefix) || k.slice(prefix.length).includes('/')) continue;
      const n = await get(k, this.store);
      out.push({ name: k.slice(prefix.length), type: n.type });
    }
    return out.sort(byDirThenName);
  }

  async read(path) {
    const p = join(split(path));
    const node = await this.#node(p);
    if (!node) throw new FsError(`Tidak ditemukan: ${p}`);
    if (node.type !== 'file') throw new FsError(`Bukan file: ${p}`);
    return node.data;
  }

  async write(path, text) {
    const segs = split(path);
    if (!segs.length) throw new FsError('Root bukan file');
    await this.mkdir(join(segs.slice(0, -1)));
    const p = join(segs);
    if ((await this.#node(p))?.type === 'dir') throw new FsError(`Itu folder: ${p}`);
    await set(p, { type: 'file', data: String(text ?? '') }, this.store);
  }

  async mkdir(path) {
    const segs = split(path);
    for (let i = 1; i <= segs.length; i++) {
      const p = join(segs.slice(0, i));
      const node = await this.#node(p);
      if (node?.type === 'file') throw new FsError(`Sudah ada file bernama: ${p}`);
      if (!node) await set(p, { type: 'dir' }, this.store);
    }
  }

  async remove(path) {
    const p = join(split(path));
    if (p === '/') throw new FsError('Root tidak bisa dihapus');
    if (!(await this.#node(p))) throw new FsError(`Tidak ditemukan: ${p}`);
    for (const k of await keys(this.store)) if (k === p || k.startsWith(p + '/')) await del(k, this.store);
  }
}

export async function createFs() {
  try {
    if (navigator.storage?.getDirectory && typeof FileSystemFileHandle !== 'undefined'
        && 'createWritable' in FileSystemFileHandle.prototype) {
      return new OpfsFs(await navigator.storage.getDirectory());
    }
  } catch { /* OPFS tidak tersedia (mis. file:// atau mode privat): pakai IndexedDB */ }
  return new IdbFs();
}
