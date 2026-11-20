// SDK sisi aplikasi. Disisipkan otomatis ke setiap app; dipakai sebagai `hawpiw.*`.
(() => {
  // Token instans & argumen dari kernel (lihat buildDoc). Meta dihapus setelah
  // dibaca; token disimpan di closure, tidak diekspos sebagai global.
  const bootEl = document.querySelector('meta[name="hawpiw-boot"]');
  const boot = JSON.parse(bootEl?.content || '{}');
  bootEl?.remove();
  const token = boot.token;
  let seq = 0;
  const pending = new Map();
  addEventListener('message', (e) => {
    const m = e.data;
    if (e.source !== parent || !m || m.hawpiw !== 1 || !pending.has(m.id)) return;
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.ok ? resolve(m.result) : reject(new Error(m.error));
  });
  const call = (name, ...args) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    parent.postMessage({ hawpiw: 1, token, id, call: name, args }, '*');
  });
  window.hawpiw = {
    args: boot.args || {},
    fs: {
      list: (p) => call('fs.list', p),
      read: (p) => call('fs.read', p),
      write: (p, t) => call('fs.write', p, t),
      mkdir: (p) => call('fs.mkdir', p),
      remove: (p) => call('fs.remove', p),
    },
    app: { list: () => call('app.list'), launch: (id, args) => call('app.launch', id, args) },
    win: { setTitle: (t) => call('win.setTitle', t) },
    backup: {
      export: () => call('backup.export'),
      import: (data, mode) => call('backup.import', data, mode),
    },
    exit: () => call('proc.exit'),
    info: () => call('sys.info'),
  };
})();
