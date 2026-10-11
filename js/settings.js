// Ajustes del usuario (persisten en IndexedDB)
import { getSetting, setSetting } from './db.js';

export const settings = {
  theme: 'auto',            // auto | light | dark
  defaultFilter: { preset: 'auto' },
  autoCapture: true,
  flashMode: 'auto',        // auto | on | off
  cameraId: null,           // cámara trasera con flash (se detecta sola)
  reviewCapture: false,     // abrir recorte tras cada captura
  detectOnImport: true,
  ocrLangs: ['spa'],
  ocrEngine: 'paddle',      // paddle | tesseract
  paddleModel: 'tiny',      // tiny (rápido) | small (máxima precisión)
  signatures: [],           // firmas guardadas (data URL PNG)
  export: { format: 'pdf', dpi: 150, quality: 0.85, pageSize: 'auto', searchable: false, grayscale: false, pageNumbers: false, watermark: '' },
};

export async function loadSettings() {
  for (const k of Object.keys(settings)) {
    const v = await getSetting(k, undefined);
    if (v !== undefined) settings[k] = (typeof settings[k] === 'object' && !Array.isArray(settings[k]) && v && typeof v === 'object') ? { ...settings[k], ...v } : v;
  }
  applyTheme();
}

export async function save(key, val) {
  settings[key] = val;
  await setSetting(key, val);
  if (key === 'theme') applyTheme();
}

export function applyTheme() {
  const r = document.documentElement;
  if (settings.theme === 'auto') r.removeAttribute('data-theme'); else r.setAttribute('data-theme', settings.theme);
}
