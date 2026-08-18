/**
 * Canvas component (design §2.2, §7, §11).
 *
 * Responsibilities: DPR-aware display, fit/zoom/pan transform, image +
 * result rendering, mask overlay, compare slider, pointer drawing with a
 * transient stroke layer (so undo snapshots always capture pre-stroke
 * state), brush cursor.
 *
 * The stroke is painted into a temporary `strokeMask` and only committed to
 * the real mask at pointerup — that lets the caller snapshot the exact
 * stroke bbox BEFORE the mask changes.
 */
import {
  composeMaskRegion,
  stampCircle,
  strokeBBox,
  type BrushState,
  type MaskMode,
  type MaskRect,
  type StrokePoint,
} from '../../core/mask';

interface Transform {
  scale: number;
  ox: number; // screen px offset
  oy: number;
}

export interface CanvasController {
  element: HTMLCanvasElement;
  setImage(bitmap: ImageBitmap | null): void;
  setMask(mask: Uint8ClampedArray | null, width: number, height: number): void;
  /** Incremental display refresh after the caller mutates the mask (undo/redo/apply). */
  refreshMaskRegion(mask: Uint8ClampedArray, rect: MaskRect): void;
  setResult(result: ImageData | null): void;
  setCompare(enabled: boolean): void;
  setSlider(fraction: number): void;
  setBeforeAfter(resultFirst: boolean): void;
  /** Current view state: true = showing the erased result. */
  isResultFirst(): boolean;
  /** Called after every setBeforeAfter so UI (e.g. the view toggle) stays in sync. */
  setOnViewChange(cb: () => void): void;
  setTool(tool: MaskMode): void;
  setBrush(brush: BrushState): void;
  /** Lock/unlock painting (e.g. result view must not draw strokes). */
  setPaintingEnabled(enabled: boolean): void;
  /** Whether the red mask overlay is drawn (only while editing). */
  setShowMask(enabled: boolean): void;
  /** Called at stroke end with the exact bbox BEFORE the mask is mutated. */
  setOnStrokeEnd(cb: (rect: MaskRect) => void): void;
  /** Called after a stroke commits (mask changed) and after undo/redo. */
  setOnMaskChanged(cb: () => void): void;
}

export function createCanvasController(canvas: HTMLCanvasElement, wrap: HTMLElement): CanvasController {
  const ctx = canvas.getContext('2d')!;
  const cursor = wrap.querySelector<HTMLElement>('#brush-cursor')!;
  const zoomHud = wrap.querySelector<HTMLElement>('#zoom-hud')!;
  const zoomLabel = wrap.querySelector<HTMLElement>('#zoom-label')!;
  const zoomFitBtn = wrap.querySelector<HTMLElement>('#btn-zoom-fit')!;

  let image: ImageBitmap | null = null;
  let mask: Uint8ClampedArray | null = null;
  let maskW = 0;
  let maskH = 0;
  let resultCanvas: HTMLCanvasElement | null = null;

  // display layer for the mask (RGBA, image resolution)
  let maskCanvas: HTMLCanvasElement | null = null;
  let maskImageData: ImageData | null = null;

  // transient stroke layer
  let strokeMask: Uint8ClampedArray | null = null;
  let strokeMode: MaskMode = 'add';
  let strokePoints: StrokePoint[] = [];

  const state = {
    transform: { scale: 1, ox: 0, oy: 0 } as Transform,
    /** scale produced by fit(): the 100% baseline for the zoom HUD */
    fitScale: 1,
    compare: false,
    slider: 0.5,
    resultFirst: false,
    tool: 'add' as MaskMode,
    brush: { size: 40, hardness: 1 } as BrushState,
    paintingEnabled: true,
    showMask: true,
  };

  let onStrokeEnd: (rect: MaskRect) => void = () => {};
  let onMaskChanged: () => void = () => {};
  let onViewChange: () => void = () => {};

  // ── sizing ─────────────────────────────────────────────────
  function resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = wrap.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    fit();
    drawScene();
  }

  function fit(): void {
    if (!image) return;
    const cw = wrap.clientWidth;
    const ch = wrap.clientHeight;
    const s = Math.min(cw / image.width, ch / image.height) * 0.95;
    state.transform = {
      scale: s,
      ox: (cw - image.width * s) / 2,
      oy: (ch - image.height * s) / 2,
    };
    state.fitScale = s;
    emitZoom();
  }

  /** Keep the zoom HUD in sync with the current transform (relative to fit). */
  function emitZoom(): void {
    if (!image) {
      zoomHud.hidden = true;
      return;
    }
    zoomHud.hidden = false;
    const pct = Math.round((state.transform.scale / state.fitScale) * 100);
    zoomLabel.textContent = `${pct}%`;
  }

  function zoomAt(sx: number, sy: number, factor: number): void {
    const t = state.transform;
    const imgX = (sx - t.ox) / t.scale;
    const imgY = (sy - t.oy) / t.scale;
    const scale = Math.min(8, Math.max(0.05, t.scale * factor));
    state.transform = { scale, ox: sx - imgX * scale, oy: sy - imgY * scale };
    drawScene();
    emitZoom();
  }

  function toggleZoom(sx: number, sy: number): void {
    if (state.transform.scale > 1.01) {
      fit();
    } else {
      zoomAt(sx, sy, 3);
    }
    drawScene();
  }

  // ── coordinate mapping ─────────────────────────────────────
  function toImage(sx: number, sy: number): { x: number; y: number } {
    const t = state.transform;
    return { x: (sx - t.ox) / t.scale, y: (sy - t.oy) / t.scale };
  }

  function toScreenRect(r: MaskRect): DOMRect {
    const t = state.transform;
    return new DOMRect(r.x * t.scale + t.ox, r.y * t.scale + t.oy, r.w * t.scale, r.h * t.scale);
  }

  // ── rendering ──────────────────────────────────────────────
  function applyViewTransform(): void {
    const dpr = window.devicePixelRatio || 1;
    const t = state.transform;
    ctx.setTransform(dpr * t.scale, 0, 0, dpr * t.scale, dpr * t.ox, dpr * t.oy);
  }

  function drawScene(rect?: MaskRect): void {
    if (!image) return;
    const img = image;
    const dpr = window.devicePixelRatio || 1;
    const t = state.transform;

    const render = (): void => {
      applyViewTransform();

      if (state.compare && resultCanvas) {
        // original full, result clipped to the slider line
        ctx.drawImage(img, 0, 0);
        const splitX = state.slider * img.width;
        ctx.save();
        ctx.beginPath();
        if (state.resultFirst) {
          ctx.rect(splitX, 0, img.width - splitX, img.height);
        } else {
          ctx.rect(0, 0, splitX, img.height);
        }
        ctx.clip();
        ctx.drawImage(resultCanvas, 0, 0);
        ctx.restore();
        // divider line
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 2 / t.scale;
        ctx.beginPath();
        ctx.moveTo(splitX, 0);
        ctx.lineTo(splitX, img.height);
        ctx.stroke();
        return;
      }

      if (state.resultFirst && resultCanvas) {
        ctx.drawImage(resultCanvas, 0, 0);
      } else {
        ctx.drawImage(img, 0, 0);
      }

      // mask overlay (hidden in compare mode and off the result view —
      // the result must show clean, and "hold to view original" must show the
      // untouched image without the red mask on top)
      if (maskCanvas && mask && state.showMask && !state.resultFirst) {
        ctx.drawImage(maskCanvas, 0, 0);
      }
    };

    if (rect) {
      // Incremental redraw: clear + clip only the dirty rect so the full-image
      // drawImage above rasterizes just that region instead of the whole canvas
      // on every pointermove — the main paint-latency cost on large images.
      // The clip is set in DEVICE-pixel space and snapped to whole device px
      // (+1px margin): a fractional clip edge anti-aliases and leaves faint
      // horizontal/vertical "border" hairlines around the stroke.
      const sx = rect.x * t.scale + t.ox;
      const sy = rect.y * t.scale + t.oy;
      const sw = rect.w * t.scale;
      const sh = rect.h * t.scale;
      const x0 = Math.floor(sx * dpr) - 1;
      const y0 = Math.floor(sy * dpr) - 1;
      const x1 = Math.ceil((sx + sw) * dpr) + 1;
      const y1 = Math.ceil((sy + sh) * dpr) + 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, y0, x1 - x0, y1 - y0);
      ctx.clip();
      ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
      render();
      ctx.restore();
    } else {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
      render();
    }
  }

  // ── stroke pipeline ────────────────────────────────────────
  function beginStroke(mode: MaskMode, p: StrokePoint): void {
    if (!image || !mask) return;
    strokeMask = new Uint8ClampedArray(mask.length);
    strokeMode = mode;
    strokePoints = [p];
    stamp(p);
  }

  function stamp(p: StrokePoint): void {
    if (!strokeMask || !mask) return;
    stampCircle(strokeMask, maskW, maskH, p.x, p.y, state.brush, 'add');
    // update the display layer for the stamp bbox
    const rect = strokeBBox([p], state.brush, maskW, maskH);
    composeMaskRegion(maskImageData!, mask, strokeMask, rect, strokeMode);
    // write the display layer back to the mask canvas so the stroke shows
    // IMMEDIATELY while drawing (not only after the pointer is released)
    maskCanvas!.getContext('2d')!.putImageData(maskImageData!, 0, 0, rect.x, rect.y, rect.w, rect.h);
    drawScene(rect);
  }

  function endStroke(): void {
    if (!strokeMask || !image || !mask) return;
    const rect = strokeBBox(strokePoints, state.brush, maskW, maskH);
    const stroke = strokeMask;
    strokeMask = null;
    if (strokePoints.length > 0) {
      // caller snapshots the PRE-stroke mask state for this exact bbox
      onStrokeEnd(rect);
      // commit the transient stroke into the real mask
      applyStroke(mask, stroke, rect, strokeMode);
      // refresh the display layer for the committed region
      composeMaskRegion(maskImageData!, mask, null, rect, 'add');
      maskCanvas!.getContext('2d')!.putImageData(maskImageData!, 0, 0);
      drawScene(rect);
      onMaskChanged();
    }
    strokePoints = [];
  }

  /** Fold a stroke layer into the committed mask (add → max, erase → min). */
  function applyStroke(target: Uint8ClampedArray, stroke: Uint8ClampedArray, rect: MaskRect, mode: MaskMode): void {
    for (let row = 0; row < rect.h; row++) {
      const i = (rect.y + row) * maskW + rect.x;
      for (let col = 0; col < rect.w; col++) {
        const idx = i + col;
        const s = stroke[idx]!;
        if (s === 0) continue;
        const cur = target[idx]!;
        target[idx] = mode === 'add' ? Math.max(cur, s) : Math.min(cur, 255 - s);
      }
    }
  }

  // ── pointer handling ───────────────────────────────────────
  const pointers = new Map<number, { sx: number; sy: number }>();
  let gestureDist = 0;
  let gestureMid = { x: 0, y: 0 };
  let gestureTransform: Transform | null = null;
  let drawing = false;

  function onPointerDown(e: PointerEvent): void {
    if (!state.paintingEnabled) return; // result view etc. must not draw
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { sx: e.clientX, sy: e.clientY });
    if (pointers.size === 1) {
      const p = toImage(e.clientX - rect().left, e.clientY - rect().top);
      beginStroke(state.tool, clampPoint(p));
      drawing = true;
    } else if (pointers.size === 2) {
      // switch to pinch: commit the in-progress stroke
      if (drawing) {
        drawing = false;
        endStroke();
      }
      const [a, b] = [...pointers.values()];
      gestureDist = Math.hypot(a!.sx - b!.sx, a!.sy - b!.sy);
      gestureMid = { x: (a!.sx + b!.sx) / 2 - rect().left, y: (a!.sy + b!.sy) / 2 - rect().top };
      gestureTransform = { ...state.transform };
    }
  }

  function onPointerMove(e: PointerEvent): void {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const sx = e.clientX - rect().left;
    const sy = e.clientY - rect().top;

    if (pointers.size === 2) {
      const other = [...pointers.entries()].find(([id]) => id !== e.pointerId)?.[1];
      if (other && gestureTransform) {
        const dist = Math.hypot(e.clientX - other.sx, e.clientY - other.sy);
        const factor = gestureDist > 0 ? dist / gestureDist : 1;
        const mid = { x: (e.clientX + other.sx) / 2 - rect().left, y: (e.clientY + other.sy) / 2 - rect().top };
        // zoom around the ORIGINAL gesture midpoint, then pan by midpoint delta
        const g = gestureTransform;
        const base = toImage(gestureMid.x, gestureMid.y);
        const scale = Math.min(8, Math.max(0.05, g.scale * factor));
        state.transform = {
          scale,
          ox: mid.x - base.x * scale,
          oy: mid.y - base.y * scale,
        };
        drawScene();
        emitZoom();
      }
      return;
    }

    if (drawing && strokeMask) {
      const img = clampPoint(toImage(sx, sy));
      const last = strokePoints[strokePoints.length - 1]!;
      if (Math.hypot(img.x - last.x, img.y - last.y) >= 0.5) {
        strokePoints.push(img);
        stamp(img);
      }
      updateCursor(sx, sy);
      return;
    }

    updateCursor(sx, sy);
  }

  function onPointerUp(e: PointerEvent): void {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) gestureTransform = null;
    if (drawing && pointers.size === 0) {
      drawing = false;
      endStroke();
    }
    hideCursor();
  }

  function onWheel(e: WheelEvent): void {
    if (!image) return;
    e.preventDefault();
    const sx = e.clientX - rect().left;
    const sy = e.clientY - rect().top;
    zoomAt(sx, sy, Math.exp(-e.deltaY * 0.0015));
  }

  function onDoubleTap(e: MouseEvent): void {
    if (!image) return;
    e.preventDefault();
    toggleZoom(e.clientX - rect().left, e.clientY - rect().top);
  }

  function clampPoint(p: { x: number; y: number }): { x: number; y: number } {
    return { x: Math.max(0, Math.min(maskW - 1, p.x)), y: Math.max(0, Math.min(maskH - 1, p.y)) };
  }

  // ── brush cursor ───────────────────────────────────────────
  function updateCursor(sx: number, sy: number): void {
    if (!image || state.compare || !state.paintingEnabled) return hideCursor();
    const r = (state.brush.size / 2) * state.transform.scale;
    cursor.hidden = false;
    cursor.style.width = `${r * 2}px`;
    cursor.style.height = `${r * 2}px`;
    cursor.style.left = `${sx - r}px`;
    cursor.style.top = `${sy - r}px`;
  }

  function hideCursor(): void {
    cursor.hidden = true;
  }

  function rect(): DOMRect {
    return wrap.getBoundingClientRect();
  }

  // ── events ─────────────────────────────────────────────────
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('dblclick', onDoubleTap);
  zoomFitBtn.addEventListener('click', () => {
    if (!image) return;
    fit();
    drawScene();
  });
  const ro = new ResizeObserver(resize);
  ro.observe(wrap);

  // ── public API ─────────────────────────────────────────────
  return {
    element: canvas,
    setImage(bitmap: ImageBitmap | null): void {
      // NOTE: the canvas does NOT close the previous bitmap — the caller
      // (main.ts) owns batch-image lifecycles and closes old batches itself.
      image = bitmap;
      resultCanvas = null;
      state.resultFirst = false;
      state.compare = false;
      if (image) {
        // sync display layer sizes
        maskW = image.width;
        maskH = image.height;
        maskCanvas = document.createElement('canvas');
        maskCanvas.width = maskW;
        maskCanvas.height = maskH;
        maskImageData = new ImageData(maskW, maskH);
      } else {
        mask = null;
        strokeMask = null;
        maskCanvas = null;
        maskImageData = null;
        cursor.hidden = true;
        zoomHud.hidden = true;
      }
      resize();
    },

    setMask(m: Uint8ClampedArray | null, width: number, height: number): void {
      mask = m;
      maskW = width;
      maskH = height;
      if (m && maskCanvas) {
        maskImageData = new ImageData(width, height);
        composeMaskRegion(maskImageData!, m, null, { x: 0, y: 0, w: width, h: height }, 'add');
        maskCanvas!.width = width;
        maskCanvas!.height = height;
        maskCanvas!.getContext('2d')!.putImageData(maskImageData!, 0, 0);
      } else {
        maskCanvas = null;
        maskImageData = null;
      }
      drawScene();
    },

    /** Incremental display refresh after the caller mutates the mask (undo/redo/apply). */
    refreshMaskRegion(mask: Uint8ClampedArray, rect: MaskRect): void {
      if (!maskCanvas || !maskImageData || !mask) return;
      composeMaskRegion(maskImageData, mask, null, rect, 'add');
      maskCanvas.getContext('2d')!.putImageData(maskImageData, 0, 0);
      drawScene(rect);
    },

    setResult(result: ImageData | null): void {
      if (result) {
        resultCanvas = document.createElement('canvas');
        resultCanvas.width = result.width;
        resultCanvas.height = result.height;
        resultCanvas.getContext('2d')!.putImageData(result, 0, 0);
      } else {
        resultCanvas = null;
      }
      drawScene();
    },

    setCompare(enabled: boolean): void {
      state.compare = enabled;
      hideCursor();
      drawScene();
    },

    setSlider(fraction: number): void {
      state.slider = Math.min(1, Math.max(0, fraction));
      drawScene();
    },

    setBeforeAfter(resultFirst: boolean): void {
      state.resultFirst = resultFirst;
      drawScene();
      onViewChange();
    },

    isResultFirst(): boolean {
      return state.resultFirst;
    },

    setTool(tool: MaskMode): void {
      state.tool = tool;
    },

    setBrush(brush: BrushState): void {
      state.brush = { ...brush };
    },

    setPaintingEnabled(enabled: boolean): void {
      state.paintingEnabled = enabled;
      if (!enabled) hideCursor();
    },

    setShowMask(enabled: boolean): void {
      state.showMask = enabled;
      drawScene();
    },

    setOnStrokeEnd(cb: (rect: MaskRect) => void): void {
      onStrokeEnd = cb;
    },

    setOnMaskChanged(cb: () => void): void {
      onMaskChanged = cb;
    },

    setOnViewChange(cb: () => void): void {
      onViewChange = cb;
    },
  };
}
