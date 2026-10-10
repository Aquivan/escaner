// Navegación sin dependencias circulares con main.js
export const go = (name, params, opts) => window.app.go(name, params, opts);
export const back = () => window.app.back();
