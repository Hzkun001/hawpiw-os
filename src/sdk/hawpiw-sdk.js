// SDK sisi aplikasi. Disisipkan otomatis ke setiap app; dipakai sebagai `hawpiw.*`.
(() => {
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
    parent.postMessage({ hawpiw: 1, id, call: name, args }, '*');
  });
  window.hawpiw = {
    args: window.HAWPIW_ARGS || {},
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
