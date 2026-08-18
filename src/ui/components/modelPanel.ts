/**
 * Model panel (design §2.3, §6): list built-in + custom models with
 * recommendation badges & reasons, current-model display, download with
 * confirm + progress + cancel, delete / re-download, add-model dialog
 * (URL or local .onnx upload with smoke test), storage panel.
 */
import type { Action, AppState, Store } from '../../core/store';
import { MODEL_REGISTRY, modelName, type ModelSpec } from '../../config/models';
import {
  cacheModel,
  deleteCachedModel,
  DownloadCancelledError,
  DownloadError,
  idbDeleteModel,
  idbGetModel,
  idbPutModel,
  isModelCached,
  requestPersistentStorage,
  storageEstimate,
} from '../../storage/modelCache';
import { detectCapabilities, isModelUsable, recommendModel, webgpuSupportsF16 } from '../../config/detect';
import { smokeTestModel } from '../../core/smokeTest';
import type { ProgressBar } from './progressBar';

export interface ModelPanelDeps {
  store: Store<AppState, Action>;
  progress: ProgressBar;
  showMessage: (title: string, text: string) => void;
  translate: (key: Parameters<typeof import('../../i18n').t>[0], vars?: Record<string, string | number>) => string;
  /** Register a re-render hook (i18n switch re-renders the panel). */
  onRender: (fn: () => void) => void;
}

/** Localized model display name (module-level so shared flows can use it). */
function modelDisplayName(deps: ModelPanelDeps, spec: ModelSpec): string {
  return modelName(spec, (k) => deps.translate(k));
}

/** Confirm dialog shown before a model download. */
function confirmDownload(deps: ModelPanelDeps, spec: ModelSpec): Promise<boolean> {
  const t = deps.translate;
  const dlg = document.getElementById('dlg-download') as HTMLDialogElement;
  const text = document.getElementById('dlg-download-text')!;
  const host = spec.url ? new URL(spec.url).host : 'local';
  text.textContent = t('model.download.prompt', { name: modelDisplayName(deps, spec), size: Math.round(spec.sizeMB), source: host });
  return new Promise((resolve) => {
    const ok = document.getElementById('dlg-download-ok')!;
    const cancel = document.getElementById('dlg-download-cancel')!;
    const done = (v: boolean): void => {
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      dlg.close();
      resolve(v);
    };
    const onOk = (): void => done(true);
    const onCancel = (): void => done(false);
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    dlg.showModal();
  });
}

/**
 * Shared download flow (offline check → confirm → progress → Cache API).
 * Used by the model management list AND the compact step-3 model bar
 * (pressing Erase with an uncached model). Returns true when the model
 * is ready to use afterwards.
 */
export async function downloadModelSpec(deps: ModelPanelDeps, spec: ModelSpec): Promise<boolean> {
  const { store, translate: t } = deps;
  if (!spec.url) return true; // local uploads need no download
  if (!navigator.onLine) {
    deps.showMessage(t('model.download.title'), t('model.download.offline'));
    return false;
  }
  const ok = await confirmDownload(deps, spec);
  if (!ok) return false;
  store.dispatch({ type: 'MODEL_CACHE_STATUS', id: spec.id, status: 'downloading' });
  const ac = new AbortController();
  deps.progress.show({
    title: t('model.download.progress', { name: modelDisplayName(deps, spec), loaded: 0, total: Math.round(spec.sizeMB), pct: 0 }),
    kind: 'download',
    cancel: () => ac.abort(),
  });
  try {
    await cacheModel(spec.url, (loaded, total) => {
      const mb = (n: number): string => (n / (1024 * 1024)).toFixed(1);
      const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
      deps.progress.update({
        title: t('model.download.progress', { name: modelDisplayName(deps, spec), loaded: mb(loaded), total: mb(total), pct }),
        pct,
      });
    }, ac.signal);
    store.dispatch({ type: 'MODEL_CACHE_STATUS', id: spec.id, status: 'cached' });
    return true;
  } catch (e) {
    store.dispatch({ type: 'MODEL_CACHE_STATUS', id: spec.id, status: 'none' });
    if (e instanceof DownloadCancelledError) {
      deps.showMessage(t('model.download.title'), t('model.download.cancelled'));
    } else if (e instanceof DownloadError) {
      const key =
        e.kind === 'offline' ? 'model.download.fail.offline'
        : e.kind === 'quota' ? 'model.download.fail.quota'
        : e.kind === 'network' ? 'model.download.fail.network'
        : 'model.download.fail.cache';
      deps.showMessage(t('model.download.title'), t(key));
    } else {
      deps.showMessage(t('model.download.title'), String(e));
    }
    return false;
  } finally {
    deps.progress.hide();
  }
}

const CUSTOM_KEY = 'inpaint.customModels';
const SELECTED_KEY = 'inpaint.selectedModel';

export function initModelPanel(deps: ModelPanelDeps): void {
  const { store, translate: t } = deps;
  const listEl = document.getElementById('model-list')!;
  const currentEl = document.getElementById('current-model')!;
  const caps = detectCapabilities();
  let recommendation: ReturnType<typeof recommendModel> | null = null;
  let cachedIds = new Set<string>();
  /** True when the current selection was auto-picked (no saved user choice). */
  let autoSelected = false;

  // seed the store with the full model list (built-ins + persisted customs).
  // balanced (fp16) is hidden when the adapter lacks `shader-f16` — it would
  // crash session creation on the GPU and is slow on CPU (design §6.5).
  const visibleBuiltins = (): ModelSpec[] =>
    caps.webgpuF16 ? MODEL_REGISTRY : MODEL_REGISTRY.filter((m) => m.id !== 'balanced');
  const initialCustom = loadCustom();
  store.dispatch({ type: 'MODELS_SET', builtin: visibleBuiltins(), custom: initialCustom });

  // Auto-select immediately (saved choice, else recommended tier, design §6.5)
  // so Erase always has a model — don't wait for the async cache scan.
  recommendation = recommendModel(caps, [...visibleBuiltins(), ...initialCustom], cachedIds);
  ensureSelection();

  requestPersistentStorage();
  void refreshCapabilities();

  /* ── capabilities (async storage fill + f16 detection) ───── */
  async function refreshCapabilities(): Promise<void> {
    try {
      const e = await storageEstimate();
      caps.freeMB = e.quota > 0 ? (e.quota - e.usage) / (1024 * 1024) : null;
    } catch {
      /* keep null */
    }
    // `shader-f16` support is async to determine — once it resolves, re-seed
    // the model list (balanced fp16 appears/disappears with f16 support) and
    // re-run the recommendation so the UI stays consistent.
    caps.webgpuF16 = await webgpuSupportsF16();
    store.dispatch({ type: 'MODELS_SET', builtin: visibleBuiltins(), custom: loadCustom() });
    const all = [...store.getState().model.builtin, ...store.getState().model.custom];
    recommendation = recommendModel(caps, all, cachedIds);
    // Re-pick when the selection was auto-made, or when the current choice was
    // just hidden (e.g. balanced on a device without shader-f16).
    const sel = store.getState().model.selected;
    if (autoSelected || !sel || !all.some((m) => m.id === sel.id)) ensureSelection();
    render();
  }

  /* ── custom models persistence ─────────────────────────────── */
  function loadCustom(): ModelSpec[] {
    try {
      const raw = localStorage.getItem(CUSTOM_KEY);
      return raw ? (JSON.parse(raw) as ModelSpec[]) : [];
    } catch {
      return [];
    }
  }

  function saveCustom(list: ModelSpec[]): void {
    try {
      localStorage.setItem(CUSTOM_KEY, JSON.stringify(list));
    } catch {
      /* ignore */
    }
  }

  /* ── cache status ──────────────────────────────────────────── */
  async function refreshCacheStatus(): Promise<void> {
    const s = store.getState();
    const all = [...s.model.builtin, ...s.model.custom];
    for (const spec of all) {
      let cached = false;
      if (spec.url) {
        cached = await isModelCached(spec.url);
      } else {
        cached = (await idbGetModel(spec.id)) !== null;
      }
      store.dispatch({ type: 'MODEL_CACHE_STATUS', id: spec.id, status: cached ? 'cached' : 'none' });
      if (cached) cachedIds.add(spec.id);
    }
    recommendation = recommendModel(caps, all, cachedIds);
    render();
  }

  /* ── selection persistence ─────────────────────────────────── */
  function ensureSelection(): void {
    try {
      const s = store.getState();
      const all = [...s.model.builtin, ...s.model.custom];
      const saved = localStorage.getItem(SELECTED_KEY);
      const match = saved ? all.find((m) => m.id === saved) : undefined;
      if (match) {
        autoSelected = false;
        store.dispatch({ type: 'MODEL_SELECTED', spec: match });
        return;
      }
      // No saved choice → auto-select the recommended tier (design §6.5).
      const rec = recommendation;
      if (rec && all.length > 0) {
        const chosen = all.find((m) => m.id === rec.recommendedId) ?? all[0]!;
        autoSelected = true;
        store.dispatch({ type: 'MODEL_SELECTED', spec: chosen });
        persistSelection(chosen.id);
      }
    } catch {
      /* ignore */
    }
  }

  /* ── download ──────────────────────────────────────────────── */
  async function downloadModel(spec: ModelSpec): Promise<void> {
    const ok = await downloadModelSpec(deps, spec);
    if (!ok) return;
    cachedIds.add(spec.id);
    recommendation = recommendModel(caps, [...store.getState().model.builtin, ...store.getState().model.custom], cachedIds);
    render();
  }

  async function deleteModel(spec: ModelSpec): Promise<void> {
    const confirmed = await confirmDialog(t('model.delete.confirm', { name: displayName(spec) }));
    if (!confirmed) return;
    if (spec.url) {
      await deleteCachedModel(spec.url);
    } else {
      await idbDeleteModel(spec.id);
    }
    cachedIds.delete(spec.id);
    store.dispatch({ type: 'MODEL_CACHE_STATUS', id: spec.id, status: 'none' });
    if (spec.kind === 'custom') {
      const custom = loadCustom().filter((m) => m.id !== spec.id);
      saveCustom(custom);
      store.dispatch({ type: 'MODELS_SET', builtin: visibleBuiltins(), custom });
    }
    const s = store.getState();
    if (s.model.selected?.id === spec.id) store.dispatch({ type: 'MODEL_SELECTED', spec: null });
    render();
  }

  /* ── add model ─────────────────────────────────────────────── */
  function openAddDialog(): void {
    const dlg = document.getElementById('dlg-add-model') as HTMLDialogElement;
    const urlInput = document.getElementById('model-url') as HTMLInputElement;
    const nameInput = document.getElementById('model-name') as HTMLInputElement;
    const fileInput = document.getElementById('model-file') as HTMLInputElement;
    const fileName = document.getElementById('model-file-name')!;
    urlInput.value = '';
    nameInput.value = '';
    fileInput.value = '';
    fileName.textContent = '';

    document.getElementById('btn-model-file')!.addEventListener('click', () => fileInput.click());
    fileInput.onchange = () => {
      const f = fileInput.files?.[0];
      fileName.textContent = f ? t('model.upload.file', { name: f.name }) : '';
    };

    const confirmBtn = document.getElementById('model-add-confirm')!;
    const onConfirm = async (): Promise<void> => {
      const url = urlInput.value.trim();
      const file = fileInput.files?.[0];
      if (!url && !file) {
        deps.showMessage(t('model.add'), t('model.add.empty'));
        return;
      }
      let spec: ModelSpec;
      if (url) {
        let path: string;
        try {
          path = new URL(url).pathname;
        } catch {
          deps.showMessage(t('model.add'), t('model.add.badUrl'));
          return;
        }
        if (!path.toLowerCase().endsWith('.onnx')) {
          deps.showMessage(t('model.add'), t('model.add.badUrl'));
          return;
        }
        const base = path.split('/').pop() ?? 'model.onnx';
        spec = {
          id: url, // matches the cache key (design §6.1)
          kind: 'custom',
          origin: 'url',
          name: nameInput.value.trim() || base,
          url,
          inputSize: 512,
          sizeMB: 0,
          threads: 4,
          fixedInput: false,
        };
      } else if (file) {
        if (!file.name.toLowerCase().endsWith('.onnx')) {
          deps.showMessage(t('model.add'), t('model.add.badUrl'));
          return;
        }
        const bytes = await file.arrayBuffer();
        const id = `${file.name}-${file.size}`;
        await idbPutModel(id, bytes);
        spec = {
          id,
          kind: 'custom',
          origin: 'upload',
          name: nameInput.value.trim() || file.name,
          inputSize: 512,
          sizeMB: Math.max(1, Math.round(file.size / (1024 * 1024))),
          threads: 4,
          fixedInput: false,
        };
      } else {
        return;
      }

      // smoke test before accepting (design §6.1)
      deps.progress.show({ title: t('inference.smokeTest'), kind: 'download' });
      try {
        await smokeTestModel(spec);
      } catch (e) {
        deps.progress.hide();
        if (spec.origin === 'upload') await idbDeleteModel(spec.id).catch(() => {});
        deps.showMessage(t('model.add'), t('model.add.smokeFail', { reason: e instanceof Error ? e.message : String(e) }));
        return;
      }
      deps.progress.hide();

      const custom = [...loadCustom().filter((m) => m.id !== spec.id), spec];
      saveCustom(custom);
      store.dispatch({ type: 'MODELS_SET', builtin: visibleBuiltins(), custom });
      store.dispatch({ type: 'MODEL_CACHE_STATUS', id: spec.id, status: spec.origin === 'upload' ? 'cached' : 'none' });
      if (spec.origin === 'upload') cachedIds.add(spec.id);
      store.dispatch({ type: 'MODEL_SELECTED', spec });
      persistSelection(spec.id);
      recommendation = recommendModel(caps, [...visibleBuiltins(), ...custom], cachedIds);
      render();
      dlg.close();
    };
    confirmBtn.onclick = () => void onConfirm();
    dlg.showModal();
    // reset on close
    dlg.onclose = () => {
      confirmBtn.onclick = null;
      fileInput.onchange = null;
    };
  }

  /* ── generic confirm dialog ────────────────────────────────── */
  function confirmDialog(text: string): Promise<boolean> {
    const dlg = document.getElementById('dlg-message') as HTMLDialogElement;
    const title = document.getElementById('dlg-message-title')!;
    const body = document.getElementById('dlg-message-text')!;
    const ok = document.getElementById('dlg-message-ok') as HTMLButtonElement;
    title.textContent = t('dlg.confirm');
    body.textContent = text;
    return new Promise((resolve) => {
      const done = (): void => {
        ok.removeEventListener('click', done);
        dlg.close();
        resolve(true);
      };
      ok.addEventListener('click', done);
      dlg.showModal();
    });
  }

  /* ── render ────────────────────────────────────────────────── */
  function displayName(spec: ModelSpec): string {
    return modelName(spec, (k) => t(k));
  }

  function render(): void {
    const s = store.getState();
    const all = [...s.model.builtin, ...s.model.custom];
    listEl.innerHTML = '';

    for (const spec of all) {
      const status = s.model.cacheStatus[spec.id] ?? 'none';
      const selected = s.model.selected?.id === spec.id;
      const reason = recommendation?.reasons[spec.id];

      const li = document.createElement('li');
      li.className = `model-item${selected ? ' selected' : ''}`;

      const head = document.createElement('div');
      head.className = 'mi-head';
      const name = document.createElement('span');
      name.className = 'mi-name';
      name.textContent = displayName(spec);
      head.appendChild(name);

      const badges = document.createElement('div');
      if (recommendation?.recommendedId === spec.id) {
        const b = document.createElement('span');
        b.className = 'badge';
        b.textContent = t('model.recommended');
        badges.appendChild(b);
      } else if (reason) {
        const b = document.createElement('span');
        b.className = 'badge reason';
        b.textContent = t('model.notRecommended');
        b.title = t(reason.key as never, reason.vars ?? {});
        badges.appendChild(b);
      }
      if (status === 'cached') {
        const b = document.createElement('span');
        b.className = 'badge muted-badge';
        b.textContent = t('model.cached');
        badges.appendChild(b);
      }
      head.appendChild(badges);
      li.appendChild(head);

      const meta = document.createElement('div');
      meta.className = 'mi-meta';
      const size = spec.sizeMB > 0 ? `${Math.round(spec.sizeMB)} MB` : '—';
      const note = spec.noteKey ? ` · ${t(spec.noteKey as never)}` : '';
      meta.textContent = `${size}${note}`;
      if (reason) {
        meta.title = t(reason.key as never, reason.vars ?? {});
      }
      li.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'mi-actions';

      const usable = isModelUsable(spec, caps, status === 'cached');
      if (selected) {
        const use = document.createElement('button');
        use.className = 'small-btn';
        use.disabled = true;
        use.textContent = '✓';
        use.title = displayName(spec);
        actions.appendChild(use);
      } else if (status === 'cached' || spec.origin === 'upload') {
        const use = document.createElement('button');
        use.className = 'small-btn';
        use.textContent = t('model.use');
        use.disabled = !caps.wasm;
        use.addEventListener('click', () => {
          store.dispatch({ type: 'MODEL_SELECTED', spec });
          persistSelection(spec.id);
          render();
        });
        actions.appendChild(use);
      }

      const cached = status === 'cached';
      if (cached) {
        const re = document.createElement('button');
        re.className = 'small-btn';
        re.textContent = t('model.redownload');
        re.addEventListener('click', () => void downloadModel(spec));
        actions.appendChild(re);
      }
      if (spec.url && usable && !cached) {
        const dl = document.createElement('button');
        dl.className = 'primary-btn';
        dl.textContent = t('model.download');
        dl.addEventListener('click', () => void downloadModel(spec));
        actions.appendChild(dl);
      } else if (spec.url && !usable && !cached) {
        const dl = document.createElement('button');
        dl.className = 'small-btn';
        dl.disabled = true;
        dl.textContent = t('model.download');
        dl.title = reason ? t(reason.key as never, reason.vars ?? {}) : t('model.why.offline');
        actions.appendChild(dl);
      }
      // delete: cached models free their cache; user-added models can always
      // be removed from the list (even before they finish downloading)
      if (cached || spec.kind === 'custom') {
        const del = document.createElement('button');
        del.className = 'small-btn';
        del.textContent = t('model.delete');
        del.addEventListener('click', () => void deleteModel(spec));
        actions.appendChild(del);
      }

      li.appendChild(actions);
      listEl.appendChild(li);
    }

    // current model display
    const sel = s.model.selected;
    if (sel) {
      currentEl.hidden = false;
      currentEl.innerHTML = '';
      const name = document.createElement('span');
      name.className = 'cm-name';
      name.textContent = displayName(sel);
      const meta = document.createElement('span');
      meta.className = 'muted';
      const source = sel.origin === 'upload' ? 'upload' : sel.url ? new URL(sel.url).host : 'builtin';
      const status = s.model.cacheStatus[sel.id] ?? 'none';
      meta.textContent = `${source} · ${sel.sizeMB > 0 ? Math.round(sel.sizeMB) + ' MB' : '—'} · ${status === 'cached' ? t('model.cached') : status === 'downloading' ? '…' : ''}`;
      currentEl.appendChild(name);
      currentEl.appendChild(meta);
    } else {
      currentEl.hidden = true;
    }

    renderEraseBar();
  }

  /**
   * Compact model selector in the step-3 bar (design §2.3 / §6.5): one
   * dropdown with every built-in + custom model, plus a one-line meta
   * explaining the recommended tier, the tier's trade-off and cache state.
   */
  function renderEraseBar(): void {
    const sel = document.getElementById('erase-model-sel') as HTMLSelectElement | null;
    const meta = document.getElementById('erase-model-meta')!;
    if (!sel) return;
    const s = store.getState();
    const all = [...s.model.builtin, ...s.model.custom];
    if (all.length === 0) return;

    const prevId = s.model.selected?.id;
    sel.innerHTML = '';
    for (const spec of all) {
      const opt = document.createElement('option');
      opt.value = spec.id;
      const isRec = recommendation?.recommendedId === spec.id;
      const size = spec.sizeMB > 0 ? `${Math.round(spec.sizeMB)} MB` : '—';
      const status = s.model.cacheStatus[spec.id] ?? 'none';
      // models that still need downloading are flagged with a warn color
      const needsDownload = !!spec.url && status !== 'cached' && status !== 'downloading';
      opt.textContent = `${needsDownload ? '⚠ ' : ''}${displayName(spec)}${isRec ? ' ⭐' : ''} · ${size}`;
      if (needsDownload) opt.style.color = 'var(--color-warn)';
      if (spec.id === prevId) opt.selected = true;
      sel.appendChild(opt);
    }

    const chosen = all.find((m) => m.id === sel.value) ?? s.model.selected;
    if (!chosen) return;
    const status = s.model.cacheStatus[chosen.id] ?? 'none';
    const isRec = recommendation?.recommendedId === chosen.id;
    const reason = recommendation?.reasons[chosen.id];
    const parts: string[] = [];
    if (isRec) parts.push(`⭐ ${t('model.recommended')}`);
    if (reason && !isRec) parts.push(`${t('model.notRecommended')}: ${t(reason.key as never, reason.vars ?? {})}`);
    if (chosen.noteKey) parts.push(t(chosen.noteKey as never));
    if (status === 'cached') parts.push(`✓ ${t('model.cached')}`);
    else if (status === 'downloading') parts.push('…');
    else if (chosen.url) parts.push(`⚠ ${t('model.needDownload')}`);
    meta.textContent = parts.join(' · ');
    meta.title = parts.join(' · ');
  }

  function persistSelection(id: string): void {
    try {
      localStorage.setItem(SELECTED_KEY, id);
    } catch {
      /* ignore */
    }
  }

  /* ── storage panel ─────────────────────────────────────────── */
  async function showStorage(): Promise<void> {
    const { usage, quota } = await storageEstimate();
    const s = store.getState();
    const cachedCount = Object.values(s.model.cacheStatus).filter((v) => v === 'cached').length;
    const mb = (n: number): string => (n / (1024 * 1024)).toFixed(0);
    const pct = quota > 0 ? Math.round((usage / quota) * 100) : 0;
    const text = t('storage.text', { used: mb(usage), quota: mb(quota), pct, models: cachedCount });
    const dlg = document.getElementById('dlg-storage') as HTMLDialogElement;
    document.getElementById('dlg-storage-text')!.textContent = text;
    dlg.showModal();
  }

  /* ── wire up ───────────────────────────────────────────────── */
  document.getElementById('btn-add-model')!.addEventListener('click', openAddDialog);
  document.getElementById('btn-storage')!.addEventListener('click', () => void showStorage());
  document.getElementById('dlg-storage-ok')!.addEventListener('click', () => {
    (document.getElementById('dlg-storage') as HTMLDialogElement).close();
  });
  document.getElementById('dlg-message-ok')!.addEventListener('click', () => {
    (document.getElementById('dlg-message') as HTMLDialogElement).close();
  });

  // compact step-3 model selector
  const eraseSel = document.getElementById('erase-model-sel') as HTMLSelectElement | null;
  eraseSel?.addEventListener('change', () => {
    const s = store.getState();
    const all = [...s.model.builtin, ...s.model.custom];
    const spec = all.find((m) => m.id === eraseSel.value);
    if (!spec) return;
    void (async () => {
      // picking an undownloaded model: ask for confirmation first
      const status = s.model.cacheStatus[spec.id] ?? 'none';
      const needsDownload = !!spec.url && status !== 'cached';
      if (needsDownload) {
        const ok = await confirmDialog(t('model.needDownloadConfirm', { size: spec.sizeMB > 0 ? ` (${Math.round(spec.sizeMB)} MB)` : '' }));
        if (!ok) {
          render(); // revert the dropdown to the previously selected model
          return;
        }
      }
      store.dispatch({ type: 'MODEL_SELECTED', spec });
      persistSelection(spec.id);
      render();
    })();
  });
  // model management dialog
  document.getElementById('btn-model-change')!.addEventListener('click', () => {
    (document.getElementById('dlg-model') as HTMLDialogElement).showModal();
  });
  document.getElementById('dlg-model-ok')!.addEventListener('click', () => {
    (document.getElementById('dlg-model') as HTMLDialogElement).close();
  });

  deps.onRender(render);
  void refreshCacheStatus().then(() => ensureSelection());
}
