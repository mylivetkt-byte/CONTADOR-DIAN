# PDF Contador Assistant AI 📄💼

Sistema automatizado para extraer discriminación de impuestos y totales desde facturas PDF con diferentes estructuras utilizando Inteligencia Artificial.

## Características
- **Watcher Inteligente**: Coloca tus archivos en la carpeta `input/` y el sistema los procesará automáticamente.
- **Extracción con IA**: Utiliza Google Gemini Pro Vision/Flash para entender cualquier formato de factura.
- **Dashboard Moderno**: Visualiza los resultados en tiempo real en una interfaz tipo Glassmorphism.

## Requisitos
1. **Node.js**: Instalado en tu sistema.
2. **Gemini API Key**: Obtén una gratis en [Google AI Studio](https://aistudio.google.com/).

## Instalación
1. Clona el repositorio o copia los archivos.
2. Ejecuta `npm install`.
3. Crea un archivo `.env` basado en `.env.example` y pega tu `GEMINI_API_KEY`.

## Cómo usar
1. Inicia el servidor:
   ```bash
   npm start
   ```
2. Abre el dashboard en tu navegador (puedes abrir directamente `frontend/index.html` o servirlo).
3. Pega tus archivos PDF en la carpeta `input/`.
4. El sistema extraerá los datos y moverá el archivo a la carpeta `processed/`.
5. Los resultados aparecerán automáticamente en el dashboard.

## Campos Extraídos
- Número de Factura
- Fecha
- Emisor & NIT
- Subtotal
- IVA
- ReteFuente & ReteICA
- Total & Moneda
