import { Chess } from 'https://esm.sh/chess.js@1.0.0?bundle';
import { Board } from './play/board.js';
import { SRS } from './play/srs.js';
import { toast } from './ui.js';

const H = (tag, props = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'on' && typeof v === 'object') {
      for (const [evt, fn] of Object.entries(v)) el.addEventListener(evt, fn);
    }
    else if (v !== null && v !== undefined) el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    if (typeof c === 'string') el.appendChild(document.createTextNode(c));
    else if (c instanceof Node) el.appendChild(c);
    else if (typeof c === 'object' && typeof c.html === 'string') el.insertAdjacentHTML('beforeend', c.html);
    else el.appendChild(document.createTextNode(String(c)));
  }
  return el;
};

const SVG = {
  arrow: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  check: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>',
  x: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  info: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  trophy: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>',
  white: '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="rgba(0,0,0,0.35)" stroke-width="1.5" fill="rgba(255,255,255,0.92)"/></svg>',
  black: '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="rgba(255,255,255,0.5)" stroke-width="1.5" fill="rgba(24,24,31,0.92)"/></svg>',
};

const OPP_DELAY = 720;

function pct(n) { return Math.max(0, Math.min(100, Math.round(n))); }
function fmtPct(n) { return pct(n) + '%'; }

class LearnController {
  constructor() {
    this.srs = new SRS();
    this.board = null;
    this.chess = null;
    this.currentLine = null;
    this.currentPly = 0;
    this.mode = 'openings';
    this.catalog = [];
    this.lineCache = new Map();
    this.session = null;
    this._oppTimer = null;
  }

  async init() {
    this._setupNav();
    this._setupTabs();
    this._setupSessionControls();
    this._renderStreak();
    this._updateReviewBadge();
    try {
      await this.loadCatalog();
      this.renderCourses();
      this.renderReviewQueue();
    } catch (e) {
      this._renderCatalogError();
    }
    window.addEventListener('hashchange', () => this._handleHash());
    this._handleHash();
  }

  _setupNav() {
    const nav = document.getElementById('nav');
    const onScroll = () => {
      if (window.scrollY > 8) nav.classList.add('scrolled');
      else nav.classList.remove('scrolled');
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  _setupTabs() {
    const tabs = document.querySelectorAll('.learn-tab');
    const panels = document.querySelectorAll('.learn-panel');
    const session = document.getElementById('learnSession');
    const glider = document.getElementById('tabGlider');

    const moveGlider = (tab) => {
      if (!tab || !glider) return;
      const rect = tab.getBoundingClientRect();
      const parentRect = tab.parentElement.getBoundingClientRect();
      glider.style.width = rect.width + 'px';
      glider.style.transform = `translateX(${rect.left - parentRect.left - 5}px)`;
    };

    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const mode = tab.dataset.mode;
        this.mode = mode;
        tabs.forEach((t) => {
          const on = t === tab;
          t.classList.toggle('on', on);
          t.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        panels.forEach((p) => {
          const on = p.dataset.panel === mode;
          p.classList.toggle('on', on);
          p.hidden = !on;
        });
        moveGlider(tab);
        if (this.session) {
          this.exitSession({ silent: true });
        }
        session.hidden = true;
        if (mode === 'review') this.renderReviewQueue();
      });
    });

    const active = document.querySelector('.learn-tab.on');
    requestAnimationFrame(() => moveGlider(active));
    window.addEventListener('resize', () => {
      moveGlider(document.querySelector('.learn-tab.on'));
    });
  }

  _handleHash() {
    const h = location.hash.replace('#', '');
    if (!h) return;
    if (h.startsWith('opening/')) {
      const id = h.split('/')[1];
      const entry = this.catalog.find((c) => c.id === id);
      if (entry) {
        this._setMode('openings');
        this.startOpeningSession(entry).catch(() => {});
      }
    } else if (h === 'review') {
      this._setMode('review');
    }
  }

  _setMode(mode) {
    const tab = document.querySelector(`.learn-tab[data-mode="${mode}"]`);
    if (tab) tab.click();
  }

  async loadCatalog() {
    const res = await fetch('assets/openings/index.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('catalog fetch failed');
    this.catalog = await res.json();
  }

  async loadLine(lineId) {
    if (this.lineCache.has(lineId)) return this.lineCache.get(lineId);
    const res = await fetch(`assets/openings/${lineId}.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error('line fetch failed: ' + lineId);
    const line = await res.json();
    this.lineCache.set(lineId, line);
    return line;
  }

  _progressPercent(lineId) {
    const p = this.srs.getLineProgress(lineId);
    if (!p.total) return 0;
    return Math.round((p.mastered / p.total) * 100);
  }

  renderCourses() {
    const grid = document.getElementById('courseGrid');
    grid.innerHTML = '';
    grid.setAttribute('aria-busy', 'false');
    if (!this.catalog.length) {
      grid.appendChild(H('div', { class: 'empty' },
        H('h3', {}, 'No openings yet'),
        H('p', {}, 'Check back soon — new lines are being added.')
      ));
      return;
    }
    this.catalog.forEach((entry, idx) => {
      const card = this._buildCourseCard(entry);
      card.style.animationDelay = (idx * 50) + 'ms';
      grid.appendChild(card);
    });
  }

  _buildCourseCard(entry) {
    const progress = this.srs.getLineProgress(entry.id);
    const percent = progress.total ? Math.round((progress.mastered / progress.total) * 100) : 0;
    const started = progress.total > 0;
    const mastered = progress.mastered;
    const totalMoves = this._userMoveCountFor(entry);

    const ring = this._buildRing(percent);
    const sideIcon = entry.side === 'black' ? SVG.black : SVG.white;

    const card = H('button', {
      type: 'button',
      class: `course-card`,
      dataset: { side: entry.side, line: entry.id },
      'aria-label': `Study ${entry.name}. ${started ? `${mastered} of ${totalMoves} moves mastered` : 'Not started'}.`,
      on: { click: () => this.startOpeningSession(entry) },
    });

    const body = H('div', { class: 'cc-body' },
      H('div', { class: 'cc-top' },
        H('span', { class: 'cc-eco' }, entry.eco),
        H('span', { class: 'cc-side' }, { html: sideIcon + ' ' + (entry.side === 'black' ? 'Black' : 'White') }),
        H('span', { class: 'cc-diff ' + entry.difficulty }, entry.difficulty)
      ),
      H('h3', { class: 'cc-name' }, entry.name),
      H('p', { class: 'cc-desc' }, this._lineBlurb(entry))
    );

    const progressText = started
      ? H('div', { class: 'cc-progress-text' },
          H('strong', {}, String(mastered) + '/' + String(totalMoves)),
          ' moves mastered'
        )
      : H('div', { class: 'cc-progress-text' }, H('strong', {}, String(totalMoves)), ' moves to learn');

    const startLabel = started ? 'Continue' : 'Start';
    const foot = H('div', { class: 'cc-foot' },
      progressText,
      H('span', { class: 'cc-start' }, { html: startLabel + SVG.arrow })
    );

    body.appendChild(foot);
    card.appendChild(body);
    card.appendChild(ring);
    return card;
  }

  _lineBlurb(entry) {
    const blurbs = {
      'ruy-lopez': 'The most respected opening in chess. White pressures the e5-defender and builds a lasting initiative.',
      'italian-game': 'A classical e4 opening. White eyes f7 and races into sharp, tactical middlegames.',
      'sicilian-najdorf': 'Black fights for the center asymmetrically and prepares ...b5 queenside expansion.',
      'caro-kann': 'A solid, resilient defense. Black challenges d5 from a stable structural base.',
      'french-defense': 'Strategic depth via a rock-solid pawn chain. Black accepts a bad bishop for clear plans.',
      'queens-gambit': 'White offers a pawn to deflect d5 and establish a dominant central duo.',
    };
    return blurbs[entry.id] || 'A core chess opening every player should know.';
  }

  _userMoveCountFor(entry) {
    return this._estimateUserMoves(entry.side);
  }

  _estimateUserMoves(side) {
    return 8;
  }

  _buildRing(percent) {
    const r = 42;
    const c = 2 * Math.PI * r;
    const offset = c * (1 - percent / 100);
    const wrap = H('div', { class: 'cc-ring' });
    wrap.innerHTML = `
      <svg viewBox="0 0 96 96" aria-hidden="true">
        <defs>
          <linearGradient id="ccGold" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#f3d678"/>
            <stop offset="60%" stop-color="#d4af37"/>
            <stop offset="100%" stop-color="#a07d1d"/>
          </linearGradient>
        </defs>
        <circle class="cc-ring-bg" cx="48" cy="48" r="${r}"/>
        <circle class="cc-ring-fill" cx="48" cy="48" r="${r}"
          stroke-dasharray="${c.toFixed(2)}"
          stroke-dashoffset="${offset.toFixed(2)}"/>
      </svg>
      <div class="cc-ring-pct">
        <span class="cc-ring-num">${percent}<small style="font-size:0.55em;opacity:0.7;">%</small></span>
        <span class="cc-ring-lbl">mastered</span>
      </div>
    `;
    return wrap;
  }

  _renderCatalogError() {
    const grid = document.getElementById('courseGrid');
    grid.innerHTML = '';
    grid.setAttribute('aria-busy', 'false');
    grid.appendChild(H('div', { class: 'empty' },
      H('h3', {}, 'Could not load openings'),
      H('p', {}, 'Check your connection and reload the page.')
    ));
  }

  renderReviewQueue() {
    const list = document.getElementById('reviewList');
    const desc = document.getElementById('reviewDesc');
    list.innerHTML = '';

    const due = this.srs.getDueItems();
    if (!due.length) {
      desc.textContent = 'No items due right now. Learn a new line above, or come back later — your spaced reviews will surface here automatically.';
      const empty = H('div', { class: 'empty' },
        H('h3', {}, 'All caught up'),
        H('p', {}, 'Nothing is due. Train a new opening, or revisit one you have started.')
      );
      list.appendChild(empty);
      this._updateReviewBadge();
      return;
    }

    desc.textContent = `${due.length} item${due.length === 1 ? '' : 's'} due. Each correct move pushes the next review further into the future.`;

    const byLine = new Map();
    due.forEach((r) => {
      if (!byLine.has(r.lineId)) byLine.set(r.lineId, []);
      byLine.get(r.lineId).push(r);
    });

    const lineNames = new Map(this.catalog.map((c) => [c.id, c.name]));

    byLine.forEach((items, lineId) => {
      const name = lineNames.get(lineId) || lineId;
      const entry = this.catalog.find((c) => c.id === lineId);
      const item = items[0];
      const dueText = this._formatDue(item.dueAt);

      const node = H('div', { class: 'review-item' },
        H('div', { class: 'ri-level', 'aria-label': 'Level ' + item.level }, 'L' + item.level),
        H('div', { class: 'ri-body' },
          H('div', { class: 'ri-line' }, name),
          H('div', { class: 'ri-meta' }, `${items.length} move${items.length === 1 ? '' : 's'} • next up: ${item.move}`)
        ),
        H('div', { class: 'ri-due ' + (item.dueAt <= Date.now() ? 'overdue' : '') }, dueText),
        H('button', {
          type: 'button',
          class: 'btn btn-primary btn-sm',
          on: { click: async () => {
            if (!entry) {
              toast({ title: 'Line unavailable', kind: 'bad' });
              return;
            }
            await this.startOpeningSession(entry, { reviewOnly: true });
          }}
        }, 'Review')
      );
      list.appendChild(node);
    });

    this._updateReviewBadge();
  }

  _formatDue(ts) {
    const diff = ts - Date.now();
    const overdue = diff <= 0;
    const abs = Math.abs(diff);
    const min = 60 * 1000;
    const hr = 60 * min;
    const day = 24 * hr;
    let s;
    if (abs < hr) s = Math.round(abs / min) + 'm';
    else if (abs < day) s = Math.round(abs / hr) + 'h';
    else s = Math.round(abs / day) + 'd';
    return overdue ? (s + ' overdue') : ('due in ' + s);
  }

  _updateReviewBadge() {
    const badge = document.getElementById('reviewBadge');
    const count = this.srs.getDueCount();
    if (count > 0) {
      badge.hidden = false;
      badge.textContent = String(count);
    } else {
      badge.hidden = true;
    }
    const reviewTab = document.querySelector('.learn-tab[data-mode="review"] span:nth-of-type(1)');
    if (reviewTab) {
      reviewTab.textContent = 'Review';
    }
  }

  _renderStreak() {
    const pill = document.getElementById('streakPill');
    const count = document.getElementById('streakCount');
    const s = this.srs.getStreak();
    if (s.count > 0) {
      pill.hidden = false;
      count.textContent = String(s.count);
      pill.classList.toggle('active', s.count >= 3);
      pill.title = `Current streak: ${s.count} day${s.count === 1 ? '' : 's'}. Best: ${s.longest}.`;
    } else {
      pill.hidden = true;
    }
  }

  async startOpeningSession(entry, opts = {}) {
    let line;
    try {
      line = await this.loadLine(entry.id);
    } catch (e) {
      toast({ title: 'Could not load line', message: entry.name, kind: 'bad' });
      return;
    }

    const userColor = line.side === 'black' ? 'b' : 'w';
    this.currentLine = line;

    this.session = {
      line,
      entry,
      userColor,
      ply: 0,
      correctFirstTry: 0,
      attempts: 0,
      streak: 0,
      reviewedKeys: new Set(),
      reviewOnly: !!opts.reviewOnly,
      done: false,
    };

    this._showSession();
    this._buildBoard(userColor);
    this._resetChess();
    this._renderSessionHead();
    this._renderSessionStats();
    this._clearFeedback();
    this._renderMoveList();
    this._setProgress(0, line.moves.length);

    document.getElementById('sessionTitle').textContent = line.name;
    document.getElementById('sessionEyebrow').textContent = opts.reviewOnly ? 'Review' : 'Opening';
    document.getElementById('sessionMeta').textContent = `${line.eco} • ${line.moves.length} plies • you play ${line.side}`;

    if (opts.reviewOnly) {
      this._jumpToFirstReviewPly();
    } else {
      this._advance();
    }
  }

  _jumpToFirstReviewPly() {
    const line = this.currentLine;
    const userColor = this.session.userColor;
    let target = -1;
    for (let i = 0; i < line.moves.length; i++) {
      const san = line.moves[i].san;
      const tmpChess = new Chess();
      for (let j = 0; j < i; j++) tmpChess.move(line.moves[j].san);
      const fen = tmpChess.fen();
      const sideToMove = tmpChess.turn();
      if (sideToMove === userColor) {
        const rec = this.srs.getRecord(line.id, fen, san);
        if (rec && rec.dueAt <= Date.now()) {
          target = i;
          break;
        }
      }
    }
    if (target < 0) {
      toast({ title: 'Nothing due in this line', kind: 'info', duration: 3000 });
      this.exitSession();
      return;
    }
    for (let i = 0; i < target; i++) {
      this.chess.move(line.moves[i].san);
    }
    this.session.ply = target;
    this.board.setPosition(this.chess);
    this._setProgress(target, line.moves.length);
    this._renderMoveList();
    this._advance();
  }

  _showSession() {
    document.querySelectorAll('.learn-panel').forEach((p) => { p.hidden = true; p.classList.remove('on'); });
    const session = document.getElementById('learnSession');
    session.hidden = false;
    session.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  _buildBoard(userColor) {
    const mount = document.getElementById('learnBoardMount');
    if (this.board) {
      this.board.destroy();
      this.board = null;
    }
    mount.innerHTML = '';
    this.board = new Board({
      mountEl: mount,
      orientation: userColor,
      interactive: false,
      onMove: ({ from, to, promotion }) => this._onUserMove(from, to, promotion),
    });
    this.board.chess = this.chess;
  }

  _resetChess() {
    this.chess = new Chess();
    if (this.board) {
      this.board.chess = this.chess;
      this.board.setPosition(this.chess);
    }
  }

  _advance() {
    if (!this.session || this.session.done) return;
    const line = this.currentLine;
    if (this.session.ply >= line.moves.length) {
      this._completeSession();
      return;
    }

    const ply = this.session.ply;
    const move = line.moves[ply];
    const sideToMove = this.chess.turn();

    if (sideToMove === this.session.userColor) {
      this._awaitUserMove(move);
    } else {
      this._awaitOpponentMove(move);
    }
  }

  _awaitOpponentMove(move) {
    this.board.setInteractive(false);
    this._setTurnIndicator({ user: false });
    this._setInstruction({
      label: 'Opponent replies',
      text: `Book move: ${move.san}. ${move.instruction}`,
      pending: false,
    });
    this._setFeedbackInfo({
      title: 'Opponent plays ' + move.san,
      text: move.instruction,
    });
    clearTimeout(this._oppTimer);
    this._oppTimer = setTimeout(() => this._playBookMove(move), OPP_DELAY);
  }

  _awaitUserMove(move) {
    this.board.setInteractive(true);
    this._setTurnIndicator({ user: true });
    this._pendingMove = move;
    const fenBefore = this.chess.fen();

    if (this.session.reviewOnly) {
      const rec = this.srs.getRecord(this.currentLine.id, fenBefore, move.san);
      if (!rec || rec.dueAt > Date.now()) {
        this.session.ply++;
        this._advance();
        return;
      }
    }

    const prompt = this._promptForMove(move);
    this._setInstruction({
      label: 'Your move',
      text: prompt,
      pending: true,
    });
    this._clearFeedback();
  }

  _promptForMove(move) {
    const line = this.currentLine;
    const ply = this.session.ply;
    if (ply === 0) return 'The position is fresh. Play the opening move for ' + (line.side === 'black' ? 'Black' : 'White') + '.';
    return 'Find the book continuation for ' + (line.side === 'black' ? 'Black' : 'White') + '.';
  }

  _playBookMove(move) {
    try {
      const played = this.chess.move(move.san);
      if (!played) {
        this._setFeedbackWarn({
          title: 'Book move unavailable',
          text: `"${move.san}" is not legal here. The line data may need correction.`,
        });
        return;
      }
    } catch (e) {
      this._setFeedbackWarn({
        title: 'Book move unavailable',
        text: `"${move.san}" is not legal here.`,
      });
      return;
    }
    this.session.ply++;
    this.board.setPosition(this.chess);
    this.board.highlight({ from: null, to: null });
    this.board.animateLastMove(this.chess);
    this._renderMoveList();
    this._setProgress(this.session.ply, this.currentLine.moves.length);
    this._advance();
  }

  _onUserMove(from, to, promotion) {
    if (!this.session || this.session.done) return;
    if (!this._pendingMove) return;
    const expected = this._pendingMove;
    const fenBefore = this.chess.fen();

    let played;
    try {
      played = this.chess.move({ from, to, promotion: promotion || 'q' });
    } catch (e) {
      played = null;
    }
    if (!played) {
      this.board.setPosition(this.chess);
      return;
    }

    const playedSan = played.san;
    const expectedSan = expected.san;

    const sanNorm = (s) => s.replace(/[+#]/g, '');
    const correct = sanNorm(playedSan) === sanNorm(expectedSan);

    this.session.attempts++;

    if (correct) {
      this.board.setPosition(this.chess);
      this.board.highlight({ from: played.from, to: played.to });
      this._markSquare(played.to, 'correct');
      this.session.streak++;
      this.session.reviewedKeys.add(this.currentLine.id + '|' + fenBefore + '|' + expectedSan);
      const rec = this.srs.review(this.currentLine.id, fenBefore, expectedSan, true);
      this.srs.recordReview();
      const isRetry = this.session._failed && this.session._failed.has(this.currentLine.id + '|' + fenBefore + '|' + expectedSan);
      if (!isRetry) this.session.correctFirstTry++;
      this._setFeedbackCorrect({
        title: 'Correct — ' + playedSan,
        text: expected.instruction,
        level: rec.level,
      });
      this._setInstruction({
        label: 'Well played',
        text: expected.instruction,
        pending: false,
      });
      this._renderSessionStats();
      this._renderStreak();
      this.session.ply++;
      this._pendingMove = null;
      this._renderMoveList({ lastUserSan: playedSan, status: 'user-correct' });
      this._setProgress(this.session.ply, this.currentLine.moves.length);
      this.board.setInteractive(false);
      setTimeout(() => {
        this._clearSquareMarks();
        this._advance();
      }, 720);
    } else {
      this.chess.undo();
      this.board.setPosition(this.chess);
      this.board.highlight({ from, to });
      this._markSquare(to, 'wrong');
      this.session.streak = 0;
      const rec = this.srs.review(this.currentLine.id, fenBefore, expectedSan, false);
      if (!this.session._failed) this.session._failed = new Set();
      this.session._failed.add(this.currentLine.id + '|' + fenBefore + '|' + expectedSan);
      this._setFeedbackWrong({
        title: 'Not the book move',
        playedSan: playedSan,
        expectedSan: expectedSan,
        text: expected.instruction,
        level: rec.level,
      });
      this._setInstruction({
        label: 'Try again',
        text: `The book move is ${expectedSan}. ${expected.instruction}`,
        pending: false,
      });
      this._renderSessionStats();
      this._renderStreak();
      this._renderMoveList({ lastUserSan: playedSan, status: 'user-wrong' });
      setTimeout(() => {
        this._clearSquareMarks();
        this.board.setInteractive(true);
      }, 1100);
    }
  }

  _markSquare(sq, cls) {
    if (!this.board || !this.board.squares[sq]) return;
    this.board.squares[sq].classList.add(cls);
  }

  _clearSquareMarks() {
    if (!this.board) return;
    for (const sq in this.board.squares) {
      this.board.squares[sq].classList.remove('correct', 'wrong', 'hint');
    }
  }

  _setTurnIndicator({ user }) {
    const turn = document.getElementById('sessionTurn');
    const turnText = turn.querySelector('.turn-text');
    turn.dataset.turn = this.chess ? this.chess.turn() : 'w';
    turn.classList.toggle('your-move', !!user);
    turn.classList.toggle('opp-move', !user);
    turnText.textContent = user ? 'Your move — find the book continuation' : 'Opponent is replying…';
  }

  _setInstruction({ label, text, pending = false }) {
    const wrap = document.getElementById('sessionInstruction');
    wrap.querySelector('.si-label').textContent = label;
    const p = wrap.querySelector('p');
    p.textContent = text;
    wrap.classList.toggle('move-pending', pending);
  }

  _setProgress(step, total) {
    const fill = document.getElementById('spFill');
    const stepEl = document.getElementById('spStep');
    const pctEl = document.getElementById('spPct');
    const ratio = total > 0 ? step / total : 0;
    fill.style.width = pct(ratio * 100) + '%';
    stepEl.textContent = `Move ${Math.min(step + 1, total)} / ${total}`;
    pctEl.textContent = fmtPct(ratio * 100);
  }

  _clearFeedback() {
    const fb = document.getElementById('sessionFeedback');
    fb.innerHTML = '';
    fb.className = 'session-feedback';
  }

  _setFeedbackCorrect({ title, text, level }) {
    const fb = document.getElementById('sessionFeedback');
    fb.className = 'session-feedback correct';
    fb.innerHTML = '';
    fb.appendChild(H('div', { class: 'fb-card' },
      H('span', { class: 'fb-ic', html: SVG.check }),
      H('div', { class: 'fb-body' },
        H('strong', {}, title + (level ? ` • Level ${level}` : '')),
        H('small', {}, text)
      )
    ));
  }

  _setFeedbackWrong({ title, playedSan, expectedSan, text, level }) {
    const fb = document.getElementById('sessionFeedback');
    fb.className = 'session-feedback wrong';
    fb.innerHTML = '';
    fb.appendChild(H('div', { class: 'fb-card' },
      H('span', { class: 'fb-ic', html: SVG.x }),
      H('div', { class: 'fb-body' },
        H('strong', {}, title),
        H('small', {}, `You played ${playedSan}. Book: `),
        H('span', { class: 'fb-san' }, expectedSan),
        H('small', {}, text)
      )
    ));
  }

  _setFeedbackInfo({ title, text }) {
    const fb = document.getElementById('sessionFeedback');
    fb.className = 'session-feedback info';
    fb.innerHTML = '';
    fb.appendChild(H('div', { class: 'fb-card' },
      H('span', { class: 'fb-ic', html: SVG.info }),
      H('div', { class: 'fb-body' },
        H('strong', {}, title),
        H('small', {}, text)
      )
    ));
  }

  _setFeedbackWarn({ title, text }) {
    const fb = document.getElementById('sessionFeedback');
    fb.className = 'session-feedback wrong';
    fb.innerHTML = '';
    fb.appendChild(H('div', { class: 'fb-card' },
      H('span', { class: 'fb-ic', html: SVG.info }),
      H('div', { class: 'fb-body' },
        H('strong', {}, title),
        H('small', {}, text)
      )
    ));
  }

  _renderMoveList(opts = {}) {
    const wrap = document.getElementById('sessionMoveList');
    wrap.innerHTML = '';
    const line = this.currentLine;
    if (!line) return;
    const playedPly = this.session.ply;
    const totalPairs = Math.ceil(line.moves.length / 2);
    for (let p = 0; p < totalPairs; p++) {
      const wIdx = p * 2;
      const bIdx = p * 2 + 1;
      if (wIdx >= playedPly) break;
      const wMove = line.moves[wIdx];
      const bMove = line.moves[bIdx];
      const wPlayed = wIdx < playedPly;
      const bPlayed = bIdx < playedPly;
      const wSan = wPlayed && wMove ? wMove.san : '';
      const bSan = bPlayed && bMove ? bMove.san : '';
      const wStatus = (opts.lastUserSan && wSan === opts.lastUserSan) ? opts.status : '';
      const bStatus = (opts.lastUserSan && bSan === opts.lastUserSan) ? opts.status : '';
      const wCls = wStatus ? `sml-move ${wStatus}` : 'sml-move';
      const bCls = bStatus ? `sml-move ${bStatus}` : (bPlayed ? 'sml-move' : 'sml-move empty');
      wrap.appendChild(H('div', { class: 'sml-row' },
        H('span', { class: 'sml-num' }, String(p + 1) + '.'),
        H('span', { class: wCls }, wSan || '—'),
        H('span', { class: bCls }, bSan || '')
      ));
    }
    wrap.scrollTop = wrap.scrollHeight;
  }

  _renderSessionHead() {
    const turn = document.getElementById('sessionTurn');
    turn.dataset.turn = this.chess ? this.chess.turn() : 'w';
    turn.querySelector('.turn-text').textContent = 'Loading position…';
  }

  _renderSessionStats() {
    if (!this.session) return;
    document.getElementById('statCorrect').textContent = String(this.session.correctFirstTry);
    document.getElementById('statAttempts').textContent = String(this.session.attempts);
    document.getElementById('statStreak').textContent = String(this.session.streak);
  }

  _completeSession() {
    if (!this.session || this.session.done) return;
    this.session.done = true;
    this.board.setInteractive(false);
    clearTimeout(this._oppTimer);
    this._setTurnIndicator({ user: false });
    document.getElementById('sessionTurn').querySelector('.turn-text').textContent = 'Line complete';
    this._clearFeedback();
    this._renderSessionStats();
    this._renderStreak();

    const totalUserMoves = this._countUserPlies();
    const correctFirst = this.session.correctFirstTry;
    const accuracy = totalUserMoves > 0 ? Math.round((correctFirst / totalUserMoves) * 100) : 100;
    const streakAfter = this.srs.getStreak();

    this._renderCompleteCard({
      title: accuracy === 100 ? 'Flawless run' : (accuracy >= 75 ? 'Solid work' : 'Line complete'),
      subtitle: `You played ${correctFirst}/${totalUserMoves} book moves correctly on the first try.`,
      accuracy,
      reviewed: this.session.reviewedKeys.size,
      streak: streakAfter.count,
    });

    this.renderCourses();
    this._updateReviewBadge();
  }

  _countUserPlies() {
    if (!this.currentLine) return 0;
    let n = 0;
    const chess = new Chess();
    for (const mv of this.currentLine.moves) {
      if (chess.turn() === this.session.userColor) n++;
      chess.move(mv.san);
    }
    return n;
  }

  _renderCompleteCard({ title, subtitle, accuracy, reviewed, streak }) {
    const side = document.querySelector('.session-side');
    side.querySelectorAll('.session-complete').forEach((n) => n.remove());
    const card = H('div', { class: 'session-complete' },
      H('span', { class: 'sc-icon', html: SVG.trophy }),
      H('h3', {}, title),
      H('p', {}, subtitle),
      H('div', { class: 'sc-stats' },
        H('div', { class: 'sc-stat' }, H('span', { class: 'sc-num' }, String(accuracy) + '%'), H('span', { class: 'sc-lbl' }, 'accuracy')),
        H('div', { class: 'sc-stat' }, H('span', { class: 'sc-num' }, String(reviewed)), H('span', { class: 'sc-lbl' }, 'reviewed')),
        H('div', { class: 'sc-stat' }, H('span', { class: 'sc-num' }, String(streak)), H('span', { class: 'sc-lbl' }, 'day streak'))
      ),
      H('div', { class: 'sc-actions' },
        H('button', { type: 'button', class: 'btn btn-ghost btn-sm', on: { click: () => this._retrySession() } }, 'Retry line'),
        H('button', { type: 'button', class: 'btn btn-primary btn-sm', on: { click: () => this.exitSession() } }, 'Back to openings')
      )
    );
    side.appendChild(card);
  }

  _retrySession() {
    if (!this.currentLine) return;
    const entry = this.catalog.find((c) => c.id === this.currentLine.id) || { id: this.currentLine.id, name: this.currentLine.name };
    this.startOpeningSession(entry, { reviewOnly: false });
  }

  exitSession({ silent = false } = {}) {
    clearTimeout(this._oppTimer);
    if (this.board) {
      this.board.destroy();
      this.board = null;
    }
    this.session = null;
    this.currentLine = null;
    this._pendingMove = null;
    document.querySelectorAll('.session-complete').forEach((n) => n.remove());
    const sessionEl = document.getElementById('learnSession');
    sessionEl.hidden = true;
    this._setMode(this.mode);
    if (!silent) {
      if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    }
  }

  _setupSessionControls() {
    document.getElementById('sessionExit').addEventListener('click', () => this.exitSession());
    document.getElementById('sessionRetry').addEventListener('click', () => this._retrySession());
    document.getElementById('sessionHint').addEventListener('click', () => this._showHint());
  }

  _showHint() {
    if (!this.session || this.session.done || !this._pendingMove) {
      toast({ title: 'No hint available', message: 'Hints appear when it is your move.', kind: 'info', duration: 2500 });
      return;
    }
    const expected = this._pendingMove;
    const chess = new Chess();
    for (let i = 0; i < this.session.ply; i++) {
      chess.move(this.currentLine.moves[i].san);
    }
    try {
      const mv = chess.move(expected.san);
      if (mv) {
        this._markSquare(mv.from, 'hint');
        this._markSquare(mv.to, 'hint');
        toast({ title: 'Hint revealed', message: `Look toward ${mv.to.toUpperCase()}.`, kind: 'info', duration: 2200 });
        setTimeout(() => this._clearSquareMarks(), 2200);
      }
    } catch (e) {
      toast({ title: 'Hint unavailable', kind: 'bad' });
    }
  }
}

const app = new LearnController();
app.init().catch((e) => {
  console.error('Learn init failed', e);
});

export { LearnController };
