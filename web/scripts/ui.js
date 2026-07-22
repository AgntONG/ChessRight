const TOAST_ICONS = {
  info: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  good: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  bad: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
};

const MAX_VISIBLE_TOASTS = 4;
const TOAST_GAP_MS = 60;

function ensureToastStack() {
  let stack = document.getElementById('toasts');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'toasts';
    stack.className = 'toast-stack';
    stack.setAttribute('role', 'status');
    stack.setAttribute('aria-live', 'polite');
    document.body.appendChild(stack);
  }
  return stack;
}

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html != null) node.innerHTML = html;
  return node;
}

export function toast({ title, message, kind = 'info', duration = 4000, actions = [] } = {}) {
  const stack = ensureToastStack();
  const k = ['info', 'good', 'bad'].includes(kind) ? kind : 'info';

  const node = el('div', `toast ${k}`);
  node.setAttribute('role', 'status');

  const icon = el('span', 'ic', TOAST_ICONS[k] || TOAST_ICONS.info);
  const body = el('div', 'body');
  if (title) body.appendChild(el('strong', '', escapeHtml(title)));
  if (message) body.appendChild(el('small', '', escapeHtml(message)));

  const safeActions = Array.isArray(actions) ? actions.slice(0, 2) : [];
  if (safeActions.length > 0) {
    const actionBar = el('div', 'toast-actions');
    safeActions.forEach((a, idx) => {
      if (!a || !a.label) return;
      const btn = el('button', idx === 0 ? 'primary' : '');
      btn.textContent = a.label;
      btn.addEventListener('click', () => {
        try {
          if (typeof a.onClick === 'function') a.onClick();
        } finally {
          dismiss();
        }
      });
      actionBar.appendChild(btn);
    });
    body.appendChild(actionBar);
  }

  node.appendChild(icon);
  node.appendChild(body);

  while (stack.children.length >= MAX_VISIBLE_TOASTS) {
    const first = stack.firstElementChild;
    if (first) first.remove();
  }

  stack.appendChild(node);

  let remaining = Math.max(800, duration | 0);
  let startedAt = performance.now();
  let timer = setTimeout(dismiss, remaining);
  let paused = false;

  node.addEventListener('mouseenter', () => {
    if (paused) return;
    paused = true;
    clearTimeout(timer);
    remaining -= performance.now() - startedAt;
    if (remaining < 0) remaining = 0;
  });
  node.addEventListener('mouseleave', () => {
    if (!paused) return;
    paused = false;
    startedAt = performance.now();
    timer = setTimeout(dismiss, Math.max(200, remaining));
  });
  node.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    dismiss();
  });

  function dismiss() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!node.parentNode) return;
    node.classList.add('leaving');
    setTimeout(() => { node.remove(); }, 320);
  }

  return dismiss;
}

export function modal({ title, body, actions = [], wide = false } = {}) {
  return new Promise((resolve) => {
    const backdrop = el('div', 'modal-backdrop');
    if (wide) backdrop.classList.add('wide');
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');

    const card = el('div', 'modal-card');
    if (wide) card.classList.add('wide');

    if (title) card.appendChild(el('h2', 'modal-title', escapeHtml(title)));

    const bodyWrap = el('div', 'modal-body');
    if (typeof body === 'string') {
      bodyWrap.innerHTML = body;
    } else if (body instanceof Node) {
      bodyWrap.appendChild(body);
    }
    card.appendChild(bodyWrap);

    let resolved = false;
    const safeActions = Array.isArray(actions) ? actions.filter(Boolean) : [];

    const close = document.createElement('button');
    close.className = 'modal-close';
    close.setAttribute('aria-label', 'Close');
    close.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    close.addEventListener('click', () => settle(null));

    function settle(value) {
      if (resolved) return;
      resolved = true;
      try { backdrop.classList.add('leaving'); } catch (_) {}
      releaseFocus();
      setTimeout(() => {
        if (backdrop.parentNode) backdrop.remove();
        document.removeEventListener('keydown', onKey);
        backdrop.removeEventListener('mousedown', onBackdrop);
        resolve(value);
      }, 180);
    }

    if (safeActions.length === 0) {
      const okBtn = document.createElement('button');
      okBtn.className = 'btn btn-primary';
      okBtn.textContent = 'OK';
      okBtn.addEventListener('click', () => settle(true));
      const wrap = el('div', 'modal-actions');
      wrap.appendChild(okBtn);
      card.appendChild(wrap);
    } else {
      const wrap = el('div', 'modal-actions');
      safeActions.forEach((a) => {
        if (!a || !a.label) return;
        const btn = document.createElement('button');
        const kind = a.kind || 'ghost';
        if (kind === 'primary') btn.className = 'btn btn-primary';
        else if (kind === 'danger') btn.className = 'btn btn-danger';
        else btn.className = 'btn btn-ghost';
        btn.textContent = a.label;
        btn.addEventListener('click', () => settle(a.value));
        wrap.appendChild(btn);
      });
      card.appendChild(wrap);
    }

    card.appendChild(close);
    backdrop.appendChild(card);

    function onBackdrop(e) {
      if (e.target !== backdrop) return;
      if (safeActions.length > 0) settle(null);
      else settle(null);
    }

    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        settle(null);
      } else if (e.key === 'Tab') {
        trapTab(e);
      }
    }

    function trapTab(e) {
      const focusables = card.querySelectorAll(
        'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])'
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    function releaseFocus() {
      if (lastFocused && typeof lastFocused.focus === 'function') {
        try { lastFocused.focus(); } catch (_) {}
      }
    }

    let lastFocused = document.activeElement;
    backdrop.addEventListener('mousedown', onBackdrop);
    document.addEventListener('keydown', onKey);

    document.body.appendChild(backdrop);

    requestAnimationFrame(() => {
      const focusables = card.querySelectorAll(
        'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])'
      );
      const initial = Array.from(focusables).find((n) => n.tagName === 'INPUT' || n.tagName === 'TEXTAREA') || close;
      try { initial.focus(); } catch (_) {}
    });
  });
}

export function confirm({
  title = 'Are you sure?',
  message = '',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
} = {}) {
  return modal({
    title,
    body: message ? `<p>${escapeHtml(message)}</p>` : '',
    actions: [
      { label: cancelLabel, value: false, kind: 'ghost' },
      {
        label: confirmLabel,
        value: true,
        kind: danger ? 'danger' : 'primary',
      },
    ],
  }).then((v) => v === true);
}

export function formatRating(rating, rd) {
  if (rating == null || (typeof rating === 'number' && !Number.isFinite(rating))) {
    return '—';
  }
  const rounded = Math.round(Number(rating));
  if (rd == null || (typeof rd === 'number' && !Number.isFinite(rd))) {
    return String(rounded);
  }
  return `${rounded} ± ${Math.round(Number(rd))}`;
}

export function formatTime(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    return '0:00';
  }
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  const mm = m < 10 ? String(m) : String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return `${mm}:${ss}`;
}

export function formatRelativeTime(timestamp) {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) {
    return 'just now';
  }
  const now = Date.now();
  const diff = Math.max(0, now - timestamp);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return min === 1 ? '1 min ago' : `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr === 1 ? '1 hour ago' : `${hr} hours ago`;
  const days = Math.floor(hr / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return days === 1 ? '1 day ago' : `${days} days ago`;
  if (days < 30) {
    const w = Math.floor(days / 7);
    return w === 1 ? '1 week ago' : `${w} weeks ago`;
  }
  const d = new Date(timestamp);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const day = d.getDate();
  return `${months[d.getMonth()]} ${day}`;
}

export function formatAccuracy(acc) {
  if (typeof acc !== 'number' || !Number.isFinite(acc)) return '—';
  const v = Math.max(0, Math.min(100, acc));
  return `${v.toFixed(1)}%`;
}

const PIECE_GLYPHS = {
  wk: '\u2654', wq: '\u2655', wr: '\u2656', wb: '\u2657', wn: '\u2658', wp: '\u2659',
  bk: '\u265A', bq: '\u265B', br: '\u265C', bb: '\u265D', bn: '\u265E', bp: '\u265F',
};

export function pieceSvg(color, type) {
  const c = String(color || 'w').toLowerCase() === 'b' ? 'b' : 'w';
  const t = String(type || 'p').toLowerCase().slice(0, 1);
  const glyph = PIECE_GLYPHS[`${c}${t}`] || PIECE_GLYPHS.wp;
  return `<span class="piece-glyph piece-${c}">${glyph}</span>`;
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const _internals = { escapeHtml };
