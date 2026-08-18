/**
 * Progress bar component: shows inference (tiles done/total) and model
 * download (loaded/total MB) progress with a cancel action.
 */
import type { Action, AppState, Store } from '../../core/store';

export interface ProgressBar {
  show(opts: { title: string; pct?: number; cancel?: () => void; kind?: 'download' | 'inference' }): void;
  update(opts: { title?: string; pct?: number; cancel?: () => void }): void;
  hide(): void;
}

export function initProgressBar(store: Store<AppState, Action>): ProgressBar {
  const el = document.getElementById('progress')!;
  const label = document.getElementById('progress-label')!;
  const bar = document.getElementById('progress-bar') as HTMLDivElement;
  const cancelBtn = document.getElementById('progress-cancel') as HTMLButtonElement;
  let onCancel: (() => void) | null = null;
  let shownBy: 'inference' | 'download' | null = null;
  let lastPct = 0;

  function renderInference(): void {
    const s = store.getState();
    const inf = s.inference;
    if (inf.status === 'running' && inf.total > 0) {
      el.hidden = false;
      const pct = Math.round((inf.done / inf.total) * 100);
      bar.style.width = `${pct}%`;
      label.textContent = `${inf.message ?? ''}  ${inf.done}/${inf.total}`;
      cancelBtn.hidden = false;
    } else if (inf.status === 'error') {
      el.hidden = false;
      label.textContent = inf.message ?? '';
      bar.style.width = '100%';
      cancelBtn.hidden = true;
    } else if (inf.status !== 'running') {
      el.hidden = true;
      shownBy = null;
      onCancel = null;
    }
  }

  function render(): void {
    if (shownBy === 'inference') {
      renderInference();
    } else if (shownBy === 'download') {
      el.hidden = false;
      bar.style.width = `${lastPct}%`;
      cancelBtn.hidden = !onCancel;
    }
  }

  cancelBtn.addEventListener('click', () => {
    onCancel?.();
  });

  store.subscribe(render);

  return {
    show(opts): void {
      shownBy = opts.kind ?? 'download';
      onCancel = opts.cancel ?? null;
      lastPct = opts.pct ?? 0;
      label.textContent = opts.title;
      bar.style.width = `${lastPct}%`;
      el.hidden = false;
      cancelBtn.hidden = !onCancel;
      if (shownBy === 'inference') renderInference();
    },
    update(opts): void {
      if (opts.title !== undefined) label.textContent = opts.title;
      if (opts.pct !== undefined) {
        lastPct = opts.pct;
        bar.style.width = `${lastPct}%`;
      }
      if (opts.cancel !== undefined) {
        onCancel = opts.cancel;
        cancelBtn.hidden = !onCancel;
      }
    },
    hide(): void {
      el.hidden = true;
      shownBy = null;
      onCancel = null;
    },
  };
}
