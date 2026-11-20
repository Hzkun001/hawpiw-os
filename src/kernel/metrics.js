// Titik ukur performa (dibaca oleh tests/perf.mjs lewat performance.getEntriesByName).
// Instrumentasi tidak boleh pernah menjatuhkan OS: browser lama (mis. Safari < 14)
// tidak mendukung bentuk objek opsi dan akan melempar error, jadi diabaikan saja.
export function measure(name, start, detail) {
  try {
    // Simpan hanya entri terakhir per nama; tanpa ini timeline tumbuh terus
    // selama OS dipakai (setiap app yang dibuka menambah satu entri).
    performance.clearMeasures(name);
    performance.measure(name, { start, end: performance.now(), detail });
  } catch { /* instrumentasi opsional */ }
}
