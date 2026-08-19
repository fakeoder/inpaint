/**
 * Entry point: wires up the store, canvas, editor tools, import/export,
 * the model panel, download & inference pipeline, and batch processing.
 *
 * UI flow (design §2.6), all on ONE page:
 *   1. Import an image            → the import hero at the top (stays visible,
 *                                  collapses to a compact bar once loaded)
 *   2. Paint over what to remove  → floating paint bar (brush size / clear)
 *   3. Erase & download           → floating erase bar (model + erase),
 *                                  then floating result actions
 * There is no left toolbar and no right panel: everything floats over the
 * canvas, so the same layout works on desktop and mobile.
 */
import './styles/index.css';

import { applyI18n, onLangChange, setLang, t } from './i18n';
import { currentThemePref, initTheme, setThemePref } from './ui/theme';
import type { ThemePref } from './storage/settings';
import { createStore, initialState, reducer, type BatchImage } from './core/store';
import { createCanvasController } from './ui/canvas';
import {
  canvasToBlob,
  decodeImage,
  downloadBlob,
  ImageDecodeError,
  isSupportedImage,
} from './core/image';
import { createMask, maskBBox, snapshotAt, type BrushState } from './core/mask';
import { BRUSH_DEFAULTS } from './config/constants';
import { initModelPanel, downloadModelSpec, type ModelPanelDeps } from './ui/components/modelPanel';
import { initProgressBar } from './ui/components/progressBar';
import { initInference } from './core/inpaint';
import { zipBlobs, type ZipEntry } from './core/zip';

// ── store ─────────────────────────────────────────────────────
const store = createStore(reducer, initialState);

// ── canvas ────────────────────────────────────────────────────
const canvasEl = document.getElementById('canvas') as HTMLCanvasElement;
const previewEl = document.getElementById('preview')!;
const canvas = createCanvasController(canvasEl, previewEl);

// ── brush state ───────────────────────────────────────────────
let brush: BrushState = { ...BRUSH_DEFAULTS };

// ── guided steps ──────────────────────────────────────────────
type Step = 'paint' | 'done';
let currentStep: Step = 'paint';

/** Show the correct control bar for the current guided step. */
function setStep(step: Step): void {
  currentStep = step;
  $('paint-bar').hidden = step !== 'paint';
  $('result-actions').hidden = step !== 'done';
  $('btn-batch-export').hidden = step !== 'done' || store.getState().batch.images.length <= 1;
  // only paint while in the paint step — clicking the result view must not draw
  canvas.setPaintingEnabled(step === 'paint');
  // the red mask overlay is only shown while editing
  canvas.setShowMask(step === 'paint');
  // the "view original" toggle in the zoom HUD is only useful with a result
  $('btn-view-toggle').hidden = step !== 'done';
  if (step === 'done') {
    $('result-actions').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    updateViewToggle();
  }
  renderSteps();
}

/** 1 ✓ → 2 ● → 3 ○ ; done steps collapse to a checkmark. */
function renderSteps(): void {
  const activeStep = currentStep === 'paint' ? 2 : 3;
  for (const el of document.querySelectorAll<HTMLElement>('#step-bar .step')) {
    const n = Number(el.dataset.step);
    const state = n < activeStep || (currentStep === 'done' && n === activeStep) ? 'done' : n === activeStep ? 'active' : 'todo';
    el.dataset.state = state;
    const num = el.querySelector('.step-num')!;
    num.textContent = state === 'done' ? '✓' : String(n);
  }
}

// ── helpers ───────────────────────────────────────────────────
function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function showMessage(title: string, text: string): void {
  const dlg = $<HTMLDialogElement>('dlg-message');
  $('dlg-message-title').textContent = title;
  $('dlg-message-text').textContent = text;
  dlg.showModal();
}

/** Keep the brush useful at the image's native pixel scale, not the viewport scale. */
function syncBrushForImage(width: number, height: number): void {
  const shortestSide = Math.min(width, height);
  const max = Math.min(2000, Math.max(200, Math.round(shortestSide * 0.25)));
  const input = $<HTMLInputElement>('brush-size');
  input.max = String(max);
  const size = Math.min(max, Math.max(Number(input.min), brush.size));
  brush = { ...brush, size };
  input.value = String(size);
  $('brush-size-value').textContent = String(size);
  setRangeFill(input);
  applyBrush();
}

function isResourceError(error: unknown): boolean {
  if (error instanceof RangeError) return true;
  if (error instanceof DOMException && ['QuotaExceededError', 'InvalidStateError', 'OperationError'].includes(error.name)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /memory|allocation|out of memory|资源|内存/i.test(message);
}

function updateToolbar(): void {
  const s = store.getState();
  const running = s.inference.status === 'running' || batchRunning;
  const canEdit = !!s.image && !!s.mask && !running;
  $('tool-erase').toggleAttribute('disabled', !canEdit);
  $('tool-erase').title = !s.image || !s.mask ? t('export.needImage') : running ? (s.inference.message || t('inference.title')) : '';
  $('tool-clear').toggleAttribute('disabled', !canEdit);
  $('btn-export').toggleAttribute('disabled', !s.image || running);
  // "Erase all" only makes sense for a real multi-image batch — hide it for a single image
  const multi = s.batch.images.length > 1;
  $('btn-batch-erase').hidden = !multi;
  $('btn-batch-erase').toggleAttribute('disabled', !multi || running);
  $('btn-batch-export').toggleAttribute('disabled', !s.batch.images.length || running);
}

store.subscribe(updateToolbar);

/** True while a batch erase loop is active (switching/editing is locked). */
let batchRunning = false;

// ── image import (picker / drag & drop / paste) ───────────────
async function importFiles(files: File[]): Promise<void> {
  if (files.length === 0) return;
  if (store.getState().inference.status === 'running') {
    showMessage(t('inference.title'), t('inference.running'));
    return;
  }
  const decoded: BatchImage[] = [];
  try {
    for (const f of files) {
      const { bitmap, width, height } = await decodeImage(f);
      decoded.push({ id: `${f.name}-${f.size}`, name: f.name, bitmap, width, height });
    }
    const first = decoded[0]!;
    // Batch requires identical dimensions so one fixed-position mask fits all.
    const mismatch = decoded.find((d) => d.width !== first.width || d.height !== first.height);
    if (mismatch) {
      for (const d of decoded) d.bitmap.close();
      showMessage(
        t('batch.sizeError'),
        t('batch.sameSizeRequired', { first: first.width, firstH: first.height, w: mismatch.width, h: mismatch.height }),
      );
      return;
    }
    // Release the previous batch's bitmaps (the canvas only holds references).
    // Done AFTER the new image is shown so no draw happens on a closed bitmap.
    const prevBatch = store.getState().batch.images;
    const mask = createMask(first.width, first.height);
    store.dispatch({ type: 'BATCH_SET', images: decoded });
    store.dispatch({ type: 'MASK_INIT', mask, width: first.width, height: first.height });
    // reveal the editor page (below the home hero) BEFORE sizing the canvas
    $('editor').hidden = false;
    canvasEl.hidden = false;
    canvas.setImage(first.bitmap);
    canvas.setMask(mask, first.width, first.height);
    syncBrushForImage(first.width, first.height);
    canvas.setResult(null);
    canvas.setBeforeAfter(false);
    for (const prev of prevBatch) prev.bitmap.close();
    renderBatchBar();
    setStep('paint');
    // scroll down to the editor page (second page below the home hero)
    $('editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    // close any bitmaps decoded before the failure
    for (const d of decoded) d.bitmap.close();
    if (e instanceof ImageDecodeError) {
      const key = e.code === 'unsupported' ? 'error.unsupported' : e.code === 'tooLarge' ? 'error.tooLarge' : 'error.read';
      showMessage(t('error.read'), t(key, e.extra ?? {}));
    } else if (isResourceError(e)) {
      showMessage(t('error.resource'), t('error.resourceDetail'));
    } else {
      showMessage(t('error.read'), e instanceof Error ? e.message : String(e));
    }
  }
}

function importFromList(list: FileList | null): void {
  const files = list ? [...list] : [];
  if (files.length === 0) return;
  // Reject unsupported files up front with a clear prompt instead of silently
  // dropping them (or failing later inside decodeImage).
  const unsupported = files.filter((f) => !isSupportedImage(f));
  const supported = files.filter((f) => isSupportedImage(f));
  if (unsupported.length > 0) {
    showMessage(
      t('error.unsupportedFormat'),
      t('error.unsupportedFormatDetail', { names: unsupported.map((f) => f.name).join(', ') }),
    );
  }
  if (supported.length > 0) void importFiles(supported);
}

$('file-input').addEventListener('change', (e) => {
  importFromList((e.target as HTMLInputElement).files);
  (e.target as HTMLInputElement).value = '';
});

$('hero-upload').addEventListener('click', () => $<HTMLInputElement>('file-input').click());

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (e.dataTransfer?.types.includes('Files')) {
    dragDepth++;
    $('drop-overlay').hidden = false;
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) $('drop-overlay').hidden = true;
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop-overlay').hidden = true;
  importFromList(e.dataTransfer?.files ?? null);
});

window.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
  const file = item?.getAsFile();
  if (file) void importFiles([file]);
});

// ── batch strip (multi-image mode) ────────────────────────────
function renderBatchBar(): void {
  const s = store.getState();
  const { images, index, results } = s.batch;
  const bar = $('batch-bar');
  const thumbs = $('batch-thumbs');
  if (images.length === 0) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  thumbs.innerHTML = '';
  $('btn-batch-erase').title = t('batch.eraseAllHint');
  $('btn-batch-erase').hidden = images.length <= 1; // single image: no "Erase all"
  $('btn-batch-export').title = t('batch.count', { n: images.length });

  for (let i = 0; i < images.length; i++) {
    const img = images[i]!;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `batch-thumb${i === index ? ' active' : ''}${results[i] ? ' done' : ''}`;
    btn.dataset.index = String(i);
    btn.title = img.name;

    const c = document.createElement('canvas');
    const scale = Math.max(56 / img.width, 56 / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    c.width = 56;
    c.height = 56;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img.bitmap, (56 - dw) / 2, (56 - dh) / 2, dw, dh);
    btn.appendChild(c);

    const check = document.createElement('span');
    check.className = 'thumb-check';
    check.textContent = '✓';
    btn.appendChild(check);
    thumbs.appendChild(btn);
  }
}

/** Apply a batch image to the view (no guards — used by the batch loop too). */
function applyBatchView(index: number): void {
  const st = store.getState();
  const img = st.batch.images[index];
  if (!img) return;
  store.dispatch({ type: 'BATCH_SELECT', index });
  const s2 = store.getState();
  canvas.setImage(img.bitmap);
  canvas.setMask(s2.mask, s2.maskWidth, s2.maskHeight);
  canvas.setResult(s2.result);
  // in the result view, show the stored result for this image, else the original
  canvas.setBeforeAfter(currentStep === 'done' && !!s2.result);
  renderBatchBar();
}

function selectBatchImage(index: number): void {
  const s = store.getState();
  if (index === s.batch.index || !s.batch.images[index]) return;
  if (s.inference.status === 'running' || batchRunning) return; // locked mid-inference
  applyBatchView(index);
}

$('batch-thumbs').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('.batch-thumb');
  if (!btn?.dataset.index) return;
  selectBatchImage(Number(btn.dataset.index));
});

/** Apply the shared fixed-position mask to every image in the batch. */
async function batchEraseAll(): Promise<void> {
  const s = store.getState();
  const { images } = s.batch;
  if (images.length === 0 || s.inference.status === 'running' || batchRunning) return;
  if (!s.mask || !maskBBox(s.mask, s.maskWidth, s.maskHeight)) {
    showMessage(t('inference.title'), t('inference.emptyMask'));
    return;
  }
  if (!s.model.selected) {
    showMessage(t('inference.title'), t('inference.noModel'));
    return;
  }
  batchRunning = true;
  updateToolbar();
  const n = images.length;
  progress.show({ title: t('batch.progress', { i: 1, n }), kind: 'inference', cancel: () => inference.cancel() });
  try {
    for (let i = 0; i < n; i++) {
      // keep the view on the image being processed
      if (store.getState().batch.index !== i) applyBatchView(i);
      await inference.run({ bitmap: images[i]!.bitmap, label: t('batch.progress', { i: i + 1, n }) });
      const st = store.getState().inference.status;
      if (st === 'error' || st === 'idle') {
        // error or user cancelled → stop the batch (completed results are kept)
        progress.hide();
        return;
      }
      store.dispatch({ type: 'BATCH_RESULT_SET', index: i, result: store.getState().result });
      renderBatchBar();
    }
  } finally {
    progress.hide();
    batchRunning = false;
    updateToolbar();
    setStep('done');
    canvas.setBeforeAfter(true);
  }
}

/** Bundle every result into one ZIP download. Images without a result fall back to the original. */
async function batchExportAll(): Promise<void> {
  const s = store.getState();
  const { images, results } = s.batch;
  if (images.length === 0) return;
  if (!results.some(Boolean)) {
    showMessage(t('batch.exportAll'), t('batch.noResult'));
    return;
  }
  const format = $<HTMLSelectElement>('export-format').value as 'png' | 'jpeg';
  const quality = Number($<HTMLInputElement>('export-quality').value);
  const ext = format === 'jpeg' ? 'jpg' : 'png';
  const entries: ZipEntry[] = [];
  for (let i = 0; i < images.length; i++) {
    const result = results[i];
    const out = document.createElement('canvas');
    const ctx = out.getContext('2d')!;
    if (result) {
      out.width = result.width;
      out.height = result.height;
      ctx.putImageData(result, 0, 0);
    } else {
      out.width = images[i]!.width;
      out.height = images[i]!.height;
      ctx.drawImage(images[i]!.bitmap, 0, 0);
    }
    const blob = await canvasToBlob(out, { format, quality });
    entries.push({ name: t('batch.exportName', { i: i + 1, ext }), data: new Uint8Array(await blob.arrayBuffer()) });
  }
  downloadBlob(zipBlobs(entries), t('batch.exportZip', { n: images.length }));
}

$('btn-batch-erase').addEventListener('click', () => void batchEraseAll());
$('btn-batch-export').addEventListener('click', () => void batchExportAll());

// ── editor tools ──────────────────────────────────────────────
// Single brush mode — only size / clear are exposed.
canvas.setTool('add');

function applyBrush(): void {
  canvas.setBrush(brush);
}

/** Fill the custom range track up to the current value. */
function setRangeFill(input: HTMLInputElement): void {
  const min = Number(input.min);
  const max = Number(input.max);
  const pct = max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 0;
  input.style.setProperty('--range-pct', `${pct}%`);
}

$<HTMLInputElement>('brush-size').addEventListener('input', (e) => {
  const input = e.target as HTMLInputElement;
  const v = Number(input.value);
  brush = { ...brush, size: v };
  $('brush-size-value').textContent = String(v);
  setRangeFill(input);
  applyBrush();
});

// re-import a new image (or batch) straight from the editor — no need to
// scroll back to the home hero.
$('btn-reimport').addEventListener('click', () => $<HTMLInputElement>('file-input').click());

// stroke → snapshot BEFORE mutation (canvas commits after the callback)
canvas.setOnStrokeEnd((rect) => {
  const s = store.getState();
  if (!s.mask) return;
  s.maskHistory.push(snapshotAt(s.mask, s.maskWidth, rect));
});
canvas.setOnMaskChanged(() => store.dispatch({ type: 'MASK_CHANGED' }));

$('tool-clear').addEventListener('click', () => {
  const s = store.getState();
  if (!s.mask) return;
  store.dispatch({ type: 'MASK_CLEARED' });
  canvas.setMask(s.mask, s.maskWidth, s.maskHeight);
  canvas.setResult(null);
  canvas.setBeforeAfter(false);
});

// ── guided step navigation ────────────────────────────────────
$('btn-edit-again').addEventListener('click', () => {
  canvas.setBeforeAfter(false); // back to the original for painting
  setStep('paint');
});

$('btn-result-import').addEventListener('click', () => $<HTMLInputElement>('file-input').click());

// change model: open the model management dialog
$('btn-model-change').addEventListener('click', () => {
  $<HTMLDialogElement>('dlg-model').showModal();
});

// ── result view: "show original" toggle in the zoom HUD ──────
/** Highlight the toggle while the original (not the result) is shown. */
function updateViewToggle(): void {
  $('btn-view-toggle').classList.toggle('active', !canvas.isResultFirst());
}
// keep the toggle in sync with every view change (single & batch erase)
canvas.setOnViewChange(updateViewToggle);
$('btn-view-toggle').addEventListener('click', () => {
  if (!store.getState().result) return;
  canvas.setBeforeAfter(!canvas.isResultFirst());
  updateViewToggle();
});

// ── export (single image via the export dialog) ───────────────
$<HTMLSelectElement>('export-format').addEventListener('change', () => {
  $('jpeg-quality-row').hidden = $<HTMLSelectElement>('export-format').value !== 'jpeg';
});

$('btn-export').addEventListener('click', () => {
  const s = store.getState();
  if (!s.image) {
    showMessage(t('export.needImage'), '');
    return;
  }
  $<HTMLDialogElement>('dlg-export').showModal();
});

$('btn-export-confirm').addEventListener('click', () => {
  const s = store.getState();
  if (!s.image) return;
  const format = $<HTMLSelectElement>('export-format').value as 'png' | 'jpeg';
  const quality = Number($<HTMLInputElement>('export-quality').value);
  const out = document.createElement('canvas');
  const outCtx = out.getContext('2d')!;
  if (s.result) {
    out.width = s.result.width;
    out.height = s.result.height;
    outCtx.putImageData(s.result, 0, 0);
  } else {
    out.width = s.image.width;
    out.height = s.image.height;
    outCtx.drawImage(s.image.bitmap, 0, 0);
  }
  void (async () => {
    const blob = await canvasToBlob(out, { format, quality });
    downloadBlob(blob, `inpaint-${Date.now()}.${format}`);
  })();
  // the enclosing <form method="dialog"> closes the dialog on submit
});

// ── i18n / theme ──────────────────────────────────────────────
initTheme();
applyI18n();
onLangChange(() => {
  applyI18n();
  renderModelPanel?.();
  renderBatchBar();
  renderSteps();
});

$('btn-lang').addEventListener('click', () => {
  setLang(document.documentElement.lang === 'zh-CN' ? 'en' : 'zh-CN');
});
$('btn-theme').addEventListener('click', () => {
  const cycle: ThemePref[] = ['system', 'light', 'dark'];
  const next = cycle[(cycle.indexOf(currentThemePref()) + 1) % cycle.length] ?? 'system';
  setThemePref(next);
});

// ── M3 wiring (model panel, progress, inference) ──────────────
let renderModelPanel: (() => void) | undefined;
const progress = initProgressBar(store);

const modelDeps: ModelPanelDeps = {
  store,
  progress,
  showMessage,
  translate: (k, vars) => t(k as never, vars),
  onRender: (fn) => {
    renderModelPanel = fn;
  },
};
initModelPanel(modelDeps);

const inference = initInference({
  store,
  canvas,
  progress,
  onReady: () => updateToolbar(),
  translate: (k, vars) => t(k as never, vars),
  showMessage,
});

/** Run the erase pipeline, then flip the canvas to the result view. */
function runErase(): void {
  if (store.getState().inference.status === 'running') return;
  progress.show({ title: t('inference.title'), kind: 'inference', cancel: () => inference.cancel() });
  void inference.run().then(() => {
    const st = store.getState().inference.status;
    if (st === 'error' || st === 'idle') progress.hide();
    // keep the result in the batch so switching images doesn't lose it
    const cur = store.getState();
    if (cur.batch.images[cur.batch.index]) {
      store.dispatch({ type: 'BATCH_RESULT_SET', index: cur.batch.index, result: cur.result });
      renderBatchBar();
    }
    if (st === 'done') {
      canvas.setBeforeAfter(true); // show the erased result on the canvas
      setStep('done');
      // Let the completed 100% state be visible before switching to results.
      void new Promise<void>((resolve) => window.setTimeout(resolve, 600)).then(() => progress.hide());
    }
  }).catch((e: unknown) => {
    progress.hide();
    showMessage(t('inference.error'), isResourceError(e) ? t('error.resourceDetail') : e instanceof Error ? e.message : String(e));
  });
}

$('tool-erase').addEventListener('click', () => {
  const s = store.getState();
  if (s.inference.status === 'running') return;
  const spec = s.model.selected;
  if (!spec) {
    showMessage(t('inference.title'), t('inference.noModel'));
    return;
  }
  // Step 3 guides the model download: prompt + progress + local cache
  // (design §6.3–6.4). Once ready, erase automatically.
  const cached = (s.model.cacheStatus[spec.id] ?? 'none') === 'cached' || spec.origin === 'upload';
  if (!cached) {
    void downloadModelSpec(modelDeps, spec).then((ok) => {
      if (ok) runErase();
    });
    return;
  }
  runErase();
});

// ── start ─────────────────────────────────────────────────────
setRangeFill($<HTMLInputElement>('brush-size'));
updateToolbar();
renderSteps();
