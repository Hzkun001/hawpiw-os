// Daftar aplikasi bawaan. Setiap app = satu dokumen HTML + manifest izin.
// Izin yang dikenal kernel: "fs" (baca/tulis berkas), "launch" (membuka app lain),
// "backup" (ekspor/impor seluruh filesystem; hanya untuk app sistem).
import filesHtml from './files.html?raw';
import notesHtml from './notes.html?raw';
import terminalHtml from './terminal.html?raw';
import backupHtml from './backup.html?raw';

export const apps = [
  { id: 'files', name: 'Berkas', icon: '📁', html: filesHtml, permissions: ['fs', 'launch'], width: 560, height: 420 },
  { id: 'notes', name: 'Catatan', icon: '📝', html: notesHtml, permissions: ['fs'], width: 600, height: 460 },
  { id: 'terminal', name: 'Terminal', icon: '⌨️', html: terminalHtml, permissions: ['fs', 'launch'], width: 640, height: 400 },
  { id: 'backup', name: 'Cadangan', icon: '💾', html: backupHtml, permissions: ['backup'], width: 480, height: 420 },
];
