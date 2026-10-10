import { processPipeline, applyFilter } from './filters.js';

self.onmessage = (e) => {
  const { id, op, img, opts } = e.data;
  try {
    const src = { data: new Uint8ClampedArray(img.buffer), width: img.width, height: img.height };
    let out;
    if (op === 'pipeline') out = processPipeline(src, opts);
    else if (op === 'filter') out = applyFilter(src, opts.filter);
    else throw new Error('op desconocida');
    self.postMessage({ id, img: { buffer: out.data.buffer, width: out.width, height: out.height } }, [out.data.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
