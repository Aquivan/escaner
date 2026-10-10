# EscánerPro (versión web)

Escáner de documentos que funciona en el navegador del móvil o del ordenador. Procesa todo en el propio dispositivo: no sube nada a ningún servidor. Se puede instalar como app (PWA) y funciona sin conexión.

## Funciones

**Escanear**
- Cámara con detección de bordes en vivo (OpenCV) y captura automática cuando el documento está quieto.
- Modo lote: varias páginas seguidas. Flash (si el móvil lo permite).
- Modo **Carnet/DNI**: anverso y reverso en una sola página A4, a tamaño real.
- Corrección de perspectiva con cálculo de la proporción real del papel (A4, Carta y Oficio se ajustan solos).
- Ajuste manual de esquinas y lados con lupa. Se abre solo si no se detectan bordes.
- Importar fotos y PDFs de la galería (o arrastrarlos en el ordenador).

**Mejorar**
- Filtros: Original, Color mejorado, Documento limpio, Grises, Blanco y negro (umbral adaptativo) y Foto.
- Brillo, contraste, nitidez y quitar sombras. Opción de aplicarlos a todas las páginas.
- Girar, recortar de nuevo, duplicar e insertar páginas.

**Organizar**
- Reordenar arrastrando (en el móvil: mantener pulsado y arrastrar).
- Unir documentos, separar (cada página, cada N o por rangos) y extraer las páginas seleccionadas.
- Buscar por nombre y **dentro del texto** reconocido por OCR.

**Texto (OCR)**
- Tesseract en español, inglés, portugués, francés, alemán, italiano, catalán, gallego y euskera. Español e inglés funcionan sin conexión.
- Copiar, descargar `.txt` y compartir.
- **PDF buscable**: añade una capa de texto invisible para buscar y seleccionar.

**Anotar y firmar**
- Texto (con ✓, ✗ y fecha rápidos), resaltador, lápiz y corrector (tapa manchas o dedos con el color del papel).
- Firma dibujada a mano o sacada de una foto (se quita el fondo). Las firmas se guardan para reutilizarlas.
- Deshacer y rehacer.

**Exportar**
- PDF, JPG, PNG o texto.
- Resolución Baja (100 ppp), Media (150), Alta (300) o la que quieras (50–600).
- Cinco niveles de compresión y **peso estimado antes de guardar**.
- Tamaño de página: automático, A4, Carta, Oficio o A5. Escala de grises, numeración de páginas y marca de agua.
- Descargar o compartir (WhatsApp, correo, etc. desde el menú del sistema).

**Herramientas PDF** (con cualquier PDF)
- Unir, separar, extraer, organizar (ordenar, girar, quitar) sin perder calidad.
- Comprimir por niveles con peso estimado.
- PDF a imágenes JPG.
- Abrir un PDF en el escáner para aplicarle filtros, OCR, firmas y anotaciones.

## Límites conocidos
- El OCR comete más errores con letra muy pequeña, borrosa o manuscrita.
- El corrector hace una limpieza básica: no reconstruye el fondo como el "borrador mágico" con IA.
- La primera apertura descarga unos 30 MB de herramientas (detección de bordes, OCR y PDF). Después quedan guardadas y la app abre rápido.

## Cómo probarla
**Link directo (claude.ai):** https://claude.ai/artifact/BptDnud4CDzmnPvQb4hjLB · En esa versión la foto se toma con la cámara del teléfono (sin vista en vivo) y el OCR usa español e inglés. Se publica desde `app.html`.

La cámara solo funciona con **HTTPS** (o `localhost`).

**En el ordenador:**
```bash
npx http-server -p 8080 -c-1 .
# abre http://localhost:8080
```

**En el móvil:** https://aquivan.github.io/escaner/ — en Chrome, menú ⋮ → *Añadir a pantalla de inicio* para instalarla como app.

## Estructura
```
  index.html, manifest.webmanifest, sw.js   app, PWA y caché sin conexión
  css/app.css                                estilos (tema claro/oscuro)
  js/main.js                                 enrutador de pantallas
  js/views/                                  inicio, cámara, recorte, editor, documento, anotar, OCR, herramientas PDF
  js/filters.js, filter-worker.js            perspectiva y filtros (JS puro, en un Web Worker)
  js/detect.js                               detección de bordes (OpenCV.js)
  js/exporter.js, export-sheet.js            PDF/JPG/PNG/TXT, PDF buscable, estimación de peso
  js/ocr-engine.js                           OCR (Tesseract.js)
  lib/                                       librerías incluidas: OpenCV.js 4.10, pdf-lib 1.17, pdf.js 3.11, Tesseract.js 5.1, JSZip 3.10
```

Para pasarla a app nativa más adelante, el mismo código puede empaquetarse con Capacitor (Android/iOS).

## OCR: PaddleOCR + Tesseract
- **PaddleOCR (PP-OCRv6, por defecto):** `lib/paddle/` contiene el SDK oficial `@paddleocr/paddleocr-js` 0.4.2, su worker, ONNX Runtime Web 1.24.3 (WASM) y los modelos PP-OCRv6 *tiny* (rápido, 6 MB) y *small* (máxima precisión, 31 MB), licencia Apache-2.0. Reconoce todos los idiomas latinos a la vez y lee mucho mejor fotos con poca luz, letra pequeña y tickets.
- **Tesseract:** respaldo automático si PaddleOCR no se puede cargar, y el único motor en la versión de claude.ai.
