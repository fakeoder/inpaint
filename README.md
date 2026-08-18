# inpaint

**Erase anything from your photos — locally in your browser.**

A static, frontend-only high-resolution object eraser powered by [LaMa](https://github.com/advimman/lama) (inpainting) running on [onnxruntime-web](https://github.com/microsoft/onnxruntime) via WASM. No backend, no uploads, no install — your images never leave your device.

![Feature: 100% private, on-device WASM inference, multi-megapixel tiling, model tiers, offline after caching, i18n, light/dark, responsive](https://img.shields.io/badge/status-alpha-orange)

## ✨ Features

- **100% private** — images and AI inference stay in your browser; nothing is ever uploaded
- **Fully on-device** — WASM inference, no install, no server; works offline once the model is cached
- **High resolution** — smart tiling handles multi-megapixel photos
- **Guided 3-step flow** — import → paint over what to remove → erase & download
- **Model tiers** — Lite / Balanced / Quality LaMa ONNX models, downloaded on demand and cached
- **Bring your own model** — add any compatible (LaMa-contract) `.onnx` via URL or local file
- **Batch mode** — import multiple same-size images and erase them all with one shared mask
- **i18n** — English & 简体中文, extensible locale packs
- **Light / dark theme** — follows the system, with manual override
- **Responsive** — desktop & mobile (touch drawing, pinch zoom)

## 🚀 Quick start

Requires [Node.js](https://nodejs.org) 18+.

```bash
npm install
npm run dev        # start the dev server
npm run build      # type-check + production build into dist/
npm run preview    # serve the production build
```

Deploy the contents of `dist/` to any static host (Cloudflare Pages, Netlify, GitHub Pages, nginx…). The site must be served with cross-origin isolation for multi-threading:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

(`npm run dev` already sends these headers.)

## 🧑‍💻 Usage

1. **Import** — pick / drag & drop / paste (Ctrl/⌘+V) one or more images (batch images must share the same size)
2. **Paint** — adjust brush Size & Hardness, paint over the objects to remove, then hit **✨ Erase** (first run downloads the LaMa model; afterwards it's cached and works offline)
3. **Erase & download** — view the result (👁 toggles the original), download PNG/JPEG or a ZIP bundle

Use **⇄ Model** to switch between model tiers, add your own model URL, or upload a local `.onnx` file.

## 🖥️ Browser support

Modern browsers with **WASM SIMD** (Chrome/Edge 91+, Firefox 89+, Safari/iOS 15.4+). Desktop Chrome is recommended for the best experience. Multi-threading requires cross-origin isolation (see above); without it the app falls back to single-threaded.

## 📦 Models

Built-in models are community-packaged LaMa ONNX exports from [g-ronimo/lama](https://huggingface.co/g-ronimo/lama) on Hugging Face (62–209 MB each), downloaded on demand and cached locally by the browser. You can also bring your own model that matches the [LaMa contract](https://github.com/advimman/lama) (input `[1,4,H,W]`, output `[1,3,H,W]`, H/W multiples of 32).

## 🛠 Tech stack

- [onnxruntime-web](https://github.com/microsoft/onnxruntime) — WASM/WebGPU inference (runs in a Web Worker)
- [Vite](https://vitejs.dev) + TypeScript (strict) — build & tooling
- [Vitest](https://vitest.dev) — unit tests
- No UI framework — hand-rolled store + canvas pipeline

## 🤝 Contributing

Open an issue or a PR. Run `npm test` before submitting.

## 📄 License

[MIT](./LICENSE) — you are free to use, modify and distribute it, provided you keep the copyright notice and attribution.
