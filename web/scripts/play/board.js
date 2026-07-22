import { Chess } from 'https://esm.sh/chess.js@1.0.0?bundle';

const GLYPH = { k: '\u265A', q: '\u265B', r: '\u265C', b: '\u265D', n: '\u265E', p: '\u265F' };
const FILES = 'abcdefgh';
const FILES_REV = 'hgfedcba';
const PROMO_TYPES = ['q', 'r', 'b', 'n'];

function sqToCoord(sq) {
  const f = sq.charCodeAt(0) - 97;
  const r = parseInt(sq[1], 10);
  return { f, r };
}

function coordToSq(f, r) {
  return FILES[f] + r;
}

function squareFromPoint(el, x, y) {
  const rect = el.getBoundingClientRect();
  const px = (x - rect.left) / rect.width;
  const py = (y - rect.top) / rect.height;
  if (px < 0 || px > 1 || py < 0 || py > 1) return null;
  const f = Math.min(7, Math.max(0, Math.floor(px * 8)));
  const r = Math.min(8, Math.max(1, 8 - Math.floor(py * 8)));
  return coordToSq(f, r);
}

export class Board {
  constructor({ mountEl, orientation = 'w', onMove, onPromotion, interactive = true }) {
    this.mountEl = mountEl;
    this.orientation = orientation === 'b' ? 'b' : 'w';
    this.onMove = typeof onMove === 'function' ? onMove : null;
    this.onPromotion = typeof onPromotion === 'function' ? onPromotion : null;
    this.interactive = !!interactive;

    this.chess = null;
    this.squares = {};
    this.pieces = {};
    this.pieceSeq = 0;

    this.selectedSq = null;
    this.legalForSelected = [];
    this.lastHighlight = null;

    this.drag = null;

    this.promoOverlay = null;
    this.promoResolver = null;

    this._build();
    this._wire();
  }

  _build() {
    this.mountEl.classList.add('board-mount');
    if (this.orientation === 'b') this.mountEl.classList.add('flipped');
    this.mountEl.innerHTML = '';

    const frag = document.createDocumentFragment();
    const ranks = this.orientation === 'w' ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
    const files = this.orientation === 'w' ? FILES.split('') : FILES_REV.split('');

    for (const r of ranks) {
      for (const f of files) {
        const sq = coordToSq(FILES.indexOf(f), r);
        const fIdx = FILES.indexOf(f);
        const light = (fIdx + r) % 2 === 0;
        const el = document.createElement('div');
        el.className = 'sq ' + (light ? 'lt' : 'dk');
        el.dataset.sq = sq;
        if (f === (this.orientation === 'w' ? 'a' : 'h')) {
          const rk = document.createElement('i');
          rk.className = 'rk';
          rk.textContent = String(r);
          el.appendChild(rk);
        }
        if (r === (this.orientation === 'w' ? 1 : 8)) {
          const fl = document.createElement('i');
          fl.className = 'fl';
          fl.textContent = f;
          el.appendChild(fl);
        }
        this.squares[sq] = el;
        frag.appendChild(el);
      }
    }
    this.mountEl.appendChild(frag);
  }

  _wire() {
    this._onPointerDown = (e) => this._handlePointerDown(e);
    this.mountEl.addEventListener('pointerdown', this._onPointerDown);
  }

  _interactiveSide(chess) {
    if (!chess) return null;
    return chess.turn();
  }

  _handlePointerDown(e) {
    if (!this.interactive || !this.chess) return;
    if (this.promoResolver) return;

    const sq = this._sqFromEvent(e);
    if (!sq) return;

    const side = this._interactiveSide(this.chess);
    const piece = this.chess.get(sq);

    if (this.selectedSq && this._isLegalTarget(sq)) {
      e.preventDefault();
      this._attemptMove(this.selectedSq, sq);
      return;
    }

    if (piece && piece.color === side) {
      e.preventDefault();
      this._selectSquare(sq);
      const pcEl = this._pieceElAt(sq);
      if (pcEl) this._beginDrag(sq, pcEl, e);
    } else {
      this._clearSelection();
    }
  }

  _sqFromEvent(e) {
    const target = e.target;
    if (target && target.dataset && target.dataset.sq) {
      return target.dataset.sq;
    }
    const parent = target && target.parentElement;
    if (parent && parent.dataset && parent.dataset.sq) {
      return parent.dataset.sq;
    }
    let node = target;
    while (node && node !== this.mountEl) {
      if (node.dataset && node.dataset.sq) return node.dataset.sq;
      node = node.parentElement;
    }
    return squareFromPoint(this.mountEl, e.clientX, e.clientY);
  }

  _pieceElAt(sq) {
    for (const id in this.pieces) {
      const el = this.pieces[id];
      if (el.dataset.sq === sq) return el;
    }
    return null;
  }

  _selectSquare(sq) {
    this._clearSelection(false);
    this.selectedSq = sq;
    if (this.squares[sq]) this.squares[sq].classList.add('sel');
    const moves = this.chess.moves({ square: sq, verbose: true });
    this.legalForSelected = moves;
    for (const m of moves) {
      const el = this.squares[m.to];
      if (!el) continue;
      el.classList.add('legal');
      if (m.flags.includes('c') || m.flags.includes('e')) {
        el.classList.add('cap');
      }
    }
  }

  _clearSelection(clearVisual = true) {
    if (clearVisual && this.selectedSq && this.squares[this.selectedSq]) {
      this.squares[this.selectedSq].classList.remove('sel');
    }
    for (const m of this.legalForSelected) {
      const el = this.squares[m.to];
      if (!el) continue;
      el.classList.remove('legal', 'cap');
    }
    this.legalForSelected = [];
    this.selectedSq = null;
  }

  _isLegalTarget(sq) {
    return this.legalForSelected.some((m) => m.to === sq);
  }

  _beginDrag(sq, pcEl, e) {
    const move = this.chess.moves({ square: sq, verbose: true });
    if (!move.length) return;
    pcEl.setPointerCapture(e.pointerId);
    pcEl.classList.add('dragging', 'interact');

    const rect = this.mountEl.getBoundingClientRect();
    this.drag = {
      sq,
      el: pcEl,
      pointerId: e.pointerId,
      rect,
      moveHandler: null,
      upHandler: null,
    };

    const onMove = (ev) => {
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      const sizePct = (rect.width / 8) / rect.width;
      pcEl.style.left = ((x / rect.width) - sizePct / 2) * 100 + '%';
      pcEl.style.top = ((y / rect.height) - sizePct / 2) * 100 + '%';
    };
    const onUp = (ev) => {
      pcEl.releasePointerCapture(ev.pointerId);
      pcEl.removeEventListener('pointermove', onMove);
      pcEl.removeEventListener('pointerup', onUp);
      pcEl.removeEventListener('pointercancel', onUp);
      pcEl.classList.remove('dragging');
      // Pointer is captured to the piece element, so ev.target is the piece
      // (whose dataset.sq is the source square). Resolve the destination by
      // geometry instead, otherwise _sqFromEvent would always return `sq`.
      const target = squareFromPoint(this.mountEl, ev.clientX, ev.clientY);
      if (target && target !== sq && this._isLegalTarget(target)) {
        this._clearSelection();
        this._attemptMove(sq, target, true);
      } else {
        this._placePiece(pcEl, sq);
        this._clearSelection();
      }
      this.drag = null;
    };
    pcEl.addEventListener('pointermove', onMove);
    pcEl.addEventListener('pointerup', onUp);
    pcEl.addEventListener('pointercancel', onUp);
  }

  _placePiece(el, sq) {
    const { f, r } = sqToCoord(sq);
    let leftPct, topPct;
    if (this.orientation === 'w') {
      leftPct = f * 12.5;
      topPct = (8 - r) * 12.5;
    } else {
      leftPct = (7 - f) * 12.5;
      topPct = (r - 1) * 12.5;
    }
    el.style.left = leftPct + '%';
    el.style.top = topPct + '%';
  }

  async _attemptMove(from, to, isDrag = false) {
    const verboseMoves = this.chess.moves({ square: from, verbose: true });
    const target = verboseMoves.find((m) => m.to === to);
    if (!target) {
      this._clearSelection();
      return;
    }

    let promotion = null;
    if (target.flags.includes('p')) {
      try {
        promotion = await this.pickPromotion(target.color);
      } catch (_) {
        this._clearSelection();
        return;
      }
    }

    this._clearSelection();
    if (this.onMove) {
      this.onMove({
        from,
        to,
        promotion,
      });
    }
  }

  setPosition(chess) {
    this.chess = chess;
    const cells = [];
    const board = chess.board();
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const cell = board[r][f];
        if (!cell) continue;
        const sq = coordToSq(f, 8 - r);
        cells.push({ square: sq, color: cell.color, type: cell.type });
      }
    }

    const live = {};
    const usedEls = new Set();
    const prevSquareById = {};
    for (const id in this.pieces) {
      prevSquareById[id] = this.pieces[id].dataset.sq;
    }

    const prevElsBySquare = {};
    for (const id in this.pieces) {
      const el = this.pieces[id];
      const sq = el.dataset.sq;
      if (sq) (prevElsBySquare[sq] = prevElsBySquare[sq] || []).push({ id, el });
    }

    const nextPieceId = () => {
      this.pieceSeq += 1;
      return 'p' + this.pieceSeq;
    };

    for (const cell of cells) {
      const sq = cell.square;
      const candidates = prevElsBySquare[sq] || [];
      let chosen = null;
      for (const c of candidates) {
        if (usedEls.has(c.el)) continue;
        if (c.el.dataset.type === cell.type && c.el.dataset.color === cell.color) {
          chosen = c;
          break;
        }
      }
      if (!chosen) {
        for (const c of candidates) {
          if (usedEls.has(c.el)) continue;
          chosen = c;
          break;
        }
      }

      let id;
      let el;
      if (chosen) {
        id = chosen.id;
        el = chosen.el;
        usedEls.add(el);
        if (el.dataset.type !== cell.type || el.dataset.color !== cell.color) {
          el.dataset.type = cell.type;
          el.dataset.color = cell.color;
          el.textContent = GLYPH[cell.type] || '';
          el.classList.toggle('w', cell.color === 'w');
          el.classList.toggle('b', cell.color === 'b');
        }
      } else {
        id = nextPieceId();
        el = document.createElement('div');
        el.className = 'pc ' + cell.color;
        el.dataset.id = id;
        el.dataset.type = cell.type;
        el.dataset.color = cell.color;
        el.textContent = GLYPH[cell.type] || '';
        this.pieces[id] = el;
        el.dataset.sq = sq;
        this._placePiece(el, sq);
        if (this.interactive) el.classList.add('interact');
        this.mountEl.appendChild(el);
        usedEls.add(el);
      }
      if (el.dataset.sq !== sq) {
        el.dataset.sq = sq;
        this._placePiece(el, sq);
      }
      live[id] = el;
    }

    for (const id in this.pieces) {
      if (!live[id]) {
        const el = this.pieces[id];
        el.classList.add('gone');
        const stale = el;
        setTimeout(() => { if (stale.parentNode) stale.remove(); }, 280);
        delete this.pieces[id];
      }
    }
  }

  animateLastMove(chess) {
    const hist = chess.history({ verbose: true });
    if (!hist.length) return;
    const last = hist[hist.length - 1];
    this.highlight({ from: last.from, to: last.to });
  }

  highlight({ from, to, check, brill = null } = {}) {
    for (const sq in this.squares) {
      this.squares[sq].classList.remove('from', 'to', 'check', 'last-brill');
    }
    if (from && this.squares[from]) this.squares[from].classList.add('from');
    if (to && this.squares[to]) this.squares[to].classList.add('to');
    if (brill && this.squares[brill]) this.squares[brill].classList.add('last-brill');
    if (check && this.squares[check]) this.squares[check].classList.add('check');
    this.lastHighlight = { from, to, check, brill };
  }

  setLegalMoves() {}

  flip() {
    this.orientation = this.orientation === 'w' ? 'b' : 'w';
    this.mountEl.classList.toggle('flipped');
    this.squares = {};
    this.pieces = {};
    this.selectedSq = null;
    this.legalForSelected = [];
    this.mountEl.innerHTML = '';
    this._build();
    if (this.chess) {
      this.setPosition(this.chess);
      if (this.lastHighlight) this.highlight(this.lastHighlight);
    }
  }

  setInteractive(bool) {
    this.interactive = !!bool;
    for (const id in this.pieces) {
      this.pieces[id].classList.toggle('interact', this.interactive);
    }
    if (!this.interactive) this._clearSelection();
  }

  async pickPromotion(color) {
    if (this.onPromotion) {
      const choice = await this.onPromotion(color);
      return choice;
    }
    return this._showPromoUI(color);
  }

  _showPromoUI(color) {
    return new Promise((resolve, reject) => {
      if (this.promoResolver) {
        this.promoResolver(null);
        this.promoResolver = null;
      }
      this.promoResolver = (val) => {
        if (this.promoOverlay) {
          this.promoOverlay.remove();
          this.promoOverlay = null;
        }
        this.promoResolver = null;
        if (val) resolve(val);
        else reject(new Error('promotion cancelled'));
      };

      const overlay = document.createElement('div');
      overlay.className = 'promo-overlay';
      const picker = document.createElement('div');
      picker.className = 'promo-picker';
      for (const t of PROMO_TYPES) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'promo-piece ' + color;
        b.textContent = GLYPH[t];
        b.dataset.piece = t;
        b.addEventListener('click', () => this.promoResolver && this.promoResolver(t));
        picker.appendChild(b);
      }
      overlay.appendChild(picker);
      this.mountEl.appendChild(overlay);
      this.promoOverlay = overlay;
    });
  }

  destroy() {
    if (this.mountEl) {
      this.mountEl.removeEventListener('pointerdown', this._onPointerDown);
      this.mountEl.innerHTML = '';
      this.mountEl.classList.remove('board-mount', 'flipped');
    }
    this.squares = {};
    this.pieces = {};
    this.selectedSq = null;
    this.legalForSelected = [];
    this.chess = null;
  }
}

export { GLYPH, FILES };
