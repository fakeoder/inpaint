import { defineConfig, type Plugin } from 'vite';
import { cpSync, createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const ortDist = join(root, 'node_modules', 'onnxruntime-web', 'dist');
const ortPublic = join(root, 'public', 'ort');

/**
 * Copy the onnxruntime-web WASM runtime files into public/ort/.
 *
 * The app must self-host the ORT runtime: under COEP `require-corp`,
 * loading it from a third-party CDN is blocked outright (design §12.2).
 * This runs on config resolution so both `vite dev` and `vite build`
 * serve a local copy. `onnxruntime-web` is a transitive-or-not devDep;
 * if it is missing we fail loudly instead of silently serving nothing.
 */
const ORT_RUNTIME_FILES = [
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
];
function copyOrtRuntime(): Plugin {
  return {
    name: 'inpaint:copy-ort-runtime',
    enforce: 'pre',
    configResolved() {
      if (!existsSync(ortDist)) {
        throw new Error(
          `onnxruntime-web dist not found at ${ortDist}. Run \`npm install\` first.`,
        );
      }
      mkdirSync(ortPublic, { recursive: true });
      // Copy ONLY the runtime variant this app actually loads. The
      // `onnxruntime-web/webgpu` bundle dynamically imports
      // `ort-wasm-simd-threaded.asyncify.{mjs,wasm}`; the other variants
      // shipped by the package (plain / jspi / jsep) are never requested,
      // so copying them would add ~50 MB of dead weight to the deployment.
      for (const entry of ORT_RUNTIME_FILES) {
        cpSync(join(ortDist, entry), join(ortPublic, entry), { force: true });
      }
    },
  };
}

/**
 * Serve the ORT runtime files from /ort/ directly in dev.
 *
 * ORT loads its wasm glue via a dynamic `import('/ort/ort-wasm-….mjs')`.
 * Vite's dev server treats such requests (they carry `?import`) as module
 * transforms and refuses them for files inside /public — "should not be
 * imported from source code". Installing this middleware ahead of Vite's
 * internal pipeline makes /ort/* requests plain static file responses, which
 * is exactly what production static hosting does. The build path is
 * unaffected (dist/ort/ is served by the static host).
 */
function serveOrtDev(): Plugin {
  const MIME: Record<string, string> = {
    '.mjs': 'text/javascript; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.wasm': 'application/wasm',
  };
  return {
    name: 'inpaint:serve-ort-dev',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0]!;
        if (!path.startsWith('/ort/')) return next();
        const file = join(ortPublic, path.slice('/ort/'.length));
        try {
          if (!statSync(file).isFile()) return next();
        } catch {
          return next();
        }
        const ext = file.slice(file.lastIndexOf('.'));
        res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-cache');
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [copyOrtRuntime(), serveOrtDev()],
  server: {
    headers: {
      // Same COOP/COEP as production so multi-threading works in dev too
      // (design §12.2: threading problems must not only surface after deploy).
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    assetsInlineLimit: 0,
  },
});
