// Shell: ikon desktop, taskbar (tombol jendela + jam). Data dirender lewat
// textContent, tidak pernah innerHTML.
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

export function mountShell(kernel) {
  const desktop = document.getElementById('desktop');
  const taskbar = document.getElementById('taskbar');

  // Ikon desktop
  const grid = el('div', { className: 'icons' });
  for (const app of kernel.listApps()) {
    const btn = el('button', { className: 'icon', title: `Buka ${app.name}` },
      el('span', { className: 'glyph', textContent: app.icon }),
      el('span', { className: 'label', textContent: app.name }));
    btn.addEventListener('click', () => kernel.launch(app.id));
    grid.append(btn);
  }
  desktop.append(grid);

  // Taskbar
  const brand = el('span', { className: 'brand', textContent: '⚡ Hawpiw' });
  const tasks = el('div', { className: 'tasks' });
  const clock = el('time', { className: 'clock' });
  taskbar.append(brand, tasks, clock);

  const renderTasks = () => {
    tasks.replaceChildren();
    for (const proc of kernel.procs.values()) {
      const { win, app } = proc;
      const b = el('button', {
        className: 'task' + (win.focused && !win.min ? ' active' : ''),
        textContent: `${app.icon} ${app.name}`,
        title: win.title,
      });
      b.addEventListener('click', () => {
        if (win.min) { win.restore(); win.focus(); }
        else if (win.focused) win.minimize();
        else win.focus();
      });
      tasks.append(b);
    }
  };
  kernel.addEventListener('change', renderTasks);

  const tick = () => {
    clock.textContent = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  };
  tick();
  setInterval(tick, 15_000);
}
