import { toast, modal, confirm, formatRating, formatTime, formatRelativeTime } from './ui.js';

const API_BASE = 'https://chessright-api.agntlol.workers.dev/api';
const TOKEN_KEY = 'cr_admin_token';
const POLL_GAMES_MS = 5000;
const POLL_QUEUE_MS = 10000;

const PRANK_LABELS = {
  force_blunder: 'Force Blunder',
  board_flip: 'Board Flip',
  silly_pieces: 'Silly Pieces',
  fake_brilliancy: 'Fake Brilliancy',
  stockfish_mode: 'Stockfish Mode',
  choose_moves: 'Choose Their Moves',
  fake_ban: 'Fake Ban',
};

const PRANK_HISTORY_ICONS = {
  force_blunder: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4 L9 9 M14 14 L20 20"/><path d="M4 20 L9 15 M14 10 L20 4"/></svg>',
  board_flip: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/></svg>',
  silly_pieces: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="9" r="3"/><circle cx="15" cy="9" r="3"/></svg>',
  fake_brilliancy: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 L13.5 8.5 L20 10 L13.5 11.5 L12 18 L10.5 11.5 L4 10 L10.5 8.5 Z"/></svg>',
  stockfish_mode: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="14" r="3"/><circle cx="16" cy="14" r="3"/></svg>',
  choose_moves: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3 L7 7 L21 17"/></svg>',
  fake_ban: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 L4 5 L4 11 C4 16 7 19 12 21 C17 19 20 16 20 11 L20 5 Z"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
};

const PIECE_GLYPH = { k: '\u2654', q: '\u2655', r: '\u2656', b: '\u2657', n: '\u2658', p: '\u2659' };

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const escapeHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function parseFenBoard(fen) {
  if (!fen || typeof fen !== 'string') return null;
  const placement = fen.split(' ')[0];
  if (!placement) return null;
  const rows = placement.split('/');
  if (rows.length !== 8) return null;
  const grid = [];
  for (const row of rows) {
    const rank = [];
    for (const ch of row) {
      if (/[1-8]/.test(ch)) {
        const n = parseInt(ch, 10);
        for (let i = 0; i < n; i++) rank.push(null);
      } else {
        const lower = ch.toLowerCase();
        if (!PIECE_GLYPH[lower]) return null;
        rank.push({ color: ch === lower ? 'b' : 'w', type: lower });
      }
    }
    if (rank.length !== 8) return null;
    grid.push(rank);
  }
  return grid;
}

function renderMiniBoard(fen) {
  const grid = parseFenBoard(fen);
  const frag = document.createDocumentFragment();
  if (!grid) {
    const empty = el('div', 'mini-board');
    for (let i = 0; i < 64; i++) {
      const r = Math.floor(i / 8), f = i % 8;
      const sq = el('div', 'sq ' + ((f + r) % 2 === 0 ? 'lt' : 'dk'));
      empty.appendChild(sq);
    }
    frag.appendChild(empty);
    return frag;
  }
  const board = el('div', 'mini-board');
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const light = (f + r) % 2 === 0;
      const sq = el('div', 'sq ' + (light ? 'lt' : 'dk'));
      const piece = grid[r][f];
      if (piece) {
        const pc = el('span', 'pc ' + (piece.color === 'w' ? 'w' : 'b'), PIECE_GLYPH[piece.type]);
        pc.setAttribute('aria-hidden', 'true');
        sq.appendChild(pc);
      }
      board.appendChild(sq);
    }
  }
  frag.appendChild(board);
  return frag;
}

class AdminPanel {
  constructor() {
    this.token = sessionStorage.getItem(TOKEN_KEY) || null;
    this.currentGameId = null;
    this.currentGame = null;
    this.currentTargetId = null;
    this.gamesCache = [];
    this.gameFilter = '';
    this.playerFilter = '';
    this.activeTab = 'games';
    this.timers = { games: null, queue: null };
    this.polling = false;
    this.visible = !document.hidden;
    this._ratingAdjustInFlight = new Set();
  }

  async init() {
    this._cacheDom();
    this._wireLogin();
    this._wireTabs();
    this._wireToolbar();
    this._wirePrankPanel();
    this._wireVisibility();

    if (this.token) {
      this.showDashboard();
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/admin/auto-auth`);
      if (res.ok) {
        const data = await res.json();
        if (data.authorized && data.token) {
          this.token = data.token;
          sessionStorage.setItem(TOKEN_KEY, this.token);
          this.showDashboard();
          return;
        }
      }
    } catch (_) {}

    this.showLogin();
  }

  _cacheDom() {
    this.dom = {
      login: $('adminLogin'),
      page: $('adminPage'),
      loginForm: $('loginForm'),
      tokenInput: $('adminTokenInput'),
      loginBtn: $('adminLoginBtn'),
      loginError: $('loginError'),
      logoutBtn: $('adminLogout'),
      tabs: $('adminTabs'),
      livePulse: document.querySelector('.live-pulse'),
      gameSearch: $('gameSearch'),
      refreshGames: $('refreshGames'),
      gamesGrid: $('gamesGrid'),
      gamesLoading: $('gamesLoading'),
      gamesEmpty: $('gamesEmpty'),
      gamesStatActive: $('gamesStatActive'),
      liveGamesCount: $('liveGamesCount'),
      playerSearch: $('playerSearch'),
      playersBody: $('playersBody'),
      playersTableWrap: $('playersTableWrap'),
      playersLoading: $('playersLoading'),
      playersEmpty: $('playersEmpty'),
      playersStatCount: $('playersStatCount'),
      queueStats: $('queueStats'),
      refreshLogs: $('refreshLogs'),
      logBody: $('logBody'),
      logLoading: $('logLoading'),
      logsEmpty: $('logsEmpty'),
      logsStatCount: $('logsStatCount'),
      prankPanel: $('prankPanel'),
      prankScrim: $('prankScrim'),
      prankClose: $('prankClose'),
      prankGame: $('prankGame'),
      prankTargetBlock: $('prankTargetBlock'),
      prankTargetOptions: $('prankTargetOptions'),
      prankGrid: $('prankGrid'),
      prankHistory: $('prankHistory'),
    };
  }

  showLogin() {
    this.dom.login.hidden = false;
    this.dom.page.hidden = true;
    this.stopPolling();
    requestAnimationFrame(() => {
      try { this.dom.tokenInput.focus(); } catch (_) {}
    });
  }

  showDashboard() {
    this.dom.login.hidden = true;
    this.dom.page.hidden = false;
    this.switchTab('games');
    this.loadAll();
    this.startPolling();
  }

  _wireLogin() {
    this.dom.loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const token = (this.dom.tokenInput.value || '').trim();
      if (!token) return;
      this.dom.loginError.hidden = true;
      this.dom.loginBtn.classList.add('loading');
      this.dom.loginBtn.disabled = true;
      try {
        await this.login(token);
      } catch (err) {
        this.dom.loginError.textContent = err && err.message
          ? err.message
          : 'Could not verify token. Try again.';
        this.dom.loginError.hidden = false;
        this.dom.tokenInput.focus();
        this.dom.tokenInput.select();
      } finally {
        this.dom.loginBtn.classList.remove('loading');
        this.dom.loginBtn.disabled = false;
      }
    });

    this.dom.logoutBtn.addEventListener('click', async () => {
      const ok = await confirm({
        title: 'Sign out of admin?',
        message: 'You will need to re-enter your token to return. The token is cleared from this tab.',
        confirmLabel: 'Sign out',
        cancelLabel: 'Stay',
      });
      if (!ok) return;
      this.token = null;
      sessionStorage.removeItem(TOKEN_KEY);
      this.currentGameId = null;
      this.closePrankPanel();
      this.showLogin();
    });
  }

  async login(token) {
    const res = await fetch(`${API_BASE}/admin/stats`, {
      headers: { 'X-Admin-Token': token },
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error('That token was rejected by the server.');
    }
    if (!res.ok) {
      throw new Error(`Server returned ${res.status}. Try again in a moment.`);
    }
    this.token = token;
    sessionStorage.setItem(TOKEN_KEY, token);
    this.showDashboard();
  }

  async _api(path, opts = {}) {
    if (!this.token) throw new Error('Not authenticated');
    const res = await fetch(`${API_BASE}${path}`, {
      ...opts,
      headers: {
        'X-Admin-Token': this.token,
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });
    if (res.status === 401 || res.status === 403) {
      this.token = null;
      sessionStorage.removeItem(TOKEN_KEY);
      this.stopPolling();
      this.closePrankPanel();
      this.showLogin();
      toast({ title: 'Session expired', message: 'Your admin token is no longer valid.', kind: 'bad' });
      throw new Error('Session expired');
    }
    if (!res.ok) {
      let msg = `Request failed (${res.status})`;
      try {
        const body = await res.json();
        if (body && body.error) msg = body.error;
      } catch (_) {}
      throw new Error(msg);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  _wireTabs() {
    this.dom.tabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.atab');
      if (!btn) return;
      this.switchTab(btn.dataset.tab);
    });
  }

  switchTab(name) {
    if (!name) return;
    this.activeTab = name;
    this.dom.tabs.querySelectorAll('.atab').forEach((b) => {
      const on = b.dataset.tab === name;
      b.classList.toggle('on', on);
      b.setAttribute('aria-current', on ? 'page' : 'false');
    });
    this.dom.page.querySelectorAll('.atab-panel').forEach((p) => {
      p.hidden = p.dataset.panel !== name;
      p.classList.toggle('on', p.dataset.panel === name);
    });
    if (name === 'players' && !this._playersLoaded) this.loadPlayers();
    if (name === 'queue' && !this._queueLoaded) this.loadStats();
    if (name === 'logs' && !this._logsLoaded) this.loadLogs();
  }

  _wireToolbar() {
    let gameTimer = null;
    this.dom.gameSearch.addEventListener('input', (e) => {
      this.gameFilter = (e.target.value || '').toLowerCase().trim();
      clearTimeout(gameTimer);
      gameTimer = setTimeout(() => this._renderGames(), 120);
    });
    this.dom.refreshGames.addEventListener('click', () => {
      this.loadGames({ showSpinner: true });
    });

    let playerTimer = null;
    this.dom.playerSearch.addEventListener('input', (e) => {
      this.playerFilter = (e.target.value || '').trim();
      clearTimeout(playerTimer);
      playerTimer = setTimeout(() => this.loadPlayers(), 220);
    });

    this.dom.refreshLogs.addEventListener('click', () => this.loadLogs({ showSpinner: true }));
  }

  async loadAll() {
    await Promise.allSettled([
      this.loadGames(),
      this.loadStats(),
      this.loadLogs(),
    ]);
  }

  async loadGames({ showSpinner = false } = {}) {
    if (showSpinner) {
      this.dom.gamesLoading.style.display = 'contents';
      this.dom.gamesEmpty.hidden = true;
    }
    try {
      const data = await this._api('/admin/games');
      const games = Array.isArray(data) ? data : (data && Array.isArray(data.games) ? data.games : []);
      this.gamesCache = games;
      this._renderGames();
    } catch (err) {
      if (String(err.message).includes('Session expired')) return;
      this._renderGamesError(err);
    } finally {
      this.dom.gamesLoading.style.display = 'none';
    }
  }

  _renderGames() {
    const grid = this.dom.gamesGrid;
    grid.innerHTML = '';
    const list = this.gamesCache;
    const filtered = this.gameFilter
      ? list.filter((g) => {
          const w = (g.white && g.white.handle || '').toLowerCase();
          const b = (g.black && g.black.handle || '').toLowerCase();
          return w.includes(this.gameFilter) || b.includes(this.gameFilter);
        })
      : list;

    if (list.length === 0) {
      this.dom.gamesEmpty.hidden = false;
      this.dom.gamesStatActive.textContent = '0 active';
      if (this.dom.liveGamesCount) this.dom.liveGamesCount.hidden = true;
      return;
    }
    this.dom.gamesEmpty.hidden = true;
    this.dom.gamesStatActive.textContent = `${list.length} active`;
    if (this.dom.liveGamesCount) {
      this.dom.liveGamesCount.textContent = String(list.length);
      this.dom.liveGamesCount.hidden = false;
    }

    if (filtered.length === 0) {
      const empty = el('div', 'empty-state inline');
      empty.innerHTML = '<h3>No matches</h3><p>No live games match that handle.</p>';
      grid.appendChild(empty);
      return;
    }

    for (const g of filtered) grid.appendChild(this._renderGameCard(g));
  }

  _renderGameCard(g) {
    const card = el('div', 'game-card');
    card.dataset.gameId = g.id || g.gameId;
    if (card.dataset.gameId === this.currentGameId) card.classList.add('active');

    const boardWrap = el('div');
    boardWrap.appendChild(renderMiniBoard(g.fen));
    card.appendChild(boardWrap);

    const meta = el('div', 'game-meta');
    const vs = el('div', 'game-vs');
    vs.appendChild(this._renderPlayerLine(g.white, 'w'));
    vs.appendChild(this._renderPlayerLine(g.black, 'b'));
    meta.appendChild(vs);

    const foot = el('div', 'game-foot');
    const turn = g.turn === 'b' ? 'Black to move' : 'White to move';
    foot.appendChild(el('span', 'game-meta-foot', escapeHtml(turn)));
    const open = el('button', 'game-open-pranks', 'Open pranks <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>');
    foot.appendChild(open);
    meta.appendChild(foot);

    card.appendChild(meta);

    card.addEventListener('click', () => this.openPrankPanel(g));
    return card;
  }

  _renderPlayerLine(p, color) {
    const line = el('div', 'game-player');
    line.appendChild(el('span', 'dot ' + color));
    const handle = p && p.handle ? p.handle : '—';
    line.appendChild(el('span', 'handle', escapeHtml(handle)));
    const rating = p && p.rating != null ? formatRating(p.rating, p.rd) : '—';
    line.appendChild(el('span', 'rating', escapeHtml(rating)));

    if (p && typeof p.timeRemainingMs === 'number') {
      const clock = el('span', 'game-clock', formatTime(p.timeRemainingMs / 1000));
      if (p.timeRemainingMs <= 20000) clock.classList.add('low');
      line.appendChild(clock);
    }
    return line;
  }

  _renderGamesError(err) {
    const grid = this.dom.gamesGrid;
    grid.innerHTML = '';
    const empty = el('div', 'empty-state');
    empty.innerHTML = `<h3>Could not load games</h3><p>${escapeHtml(err.message || 'Unknown error')}. <button class="link-btn" id="retryGames">Retry</button></p>`;
    grid.appendChild(empty);
    const retry = $('retryGames');
    if (retry) retry.addEventListener('click', () => this.loadGames({ showSpinner: true }));
  }

  async loadPlayers() {
    this.dom.playersLoading.style.display = 'block';
    this.dom.playersBody.innerHTML = '';
    this.dom.playersEmpty.hidden = true;
    try {
      const q = this.playerFilter ? `?q=${encodeURIComponent(this.playerFilter)}` : '';
      const data = await this._api(`/admin/users${q}`);
      const users = Array.isArray(data) ? data : (data && Array.isArray(data.users) ? data.users : []);
      this._playersLoaded = true;
      this._renderPlayers(users);
    } catch (err) {
      if (String(err.message).includes('Session expired')) return;
      this.dom.playersBody.innerHTML = '';
      const row = el('tr');
      const cell = el('td');
      cell.colSpan = 5;
      cell.innerHTML = `<span class="toolbar-stat">Error: ${escapeHtml(err.message)}</span>`;
      row.appendChild(cell);
      this.dom.playersBody.appendChild(row);
    } finally {
      this.dom.playersLoading.style.display = 'none';
    }
  }

  _renderPlayers(users) {
    const body = this.dom.playersBody;
    body.innerHTML = '';
    this.dom.playersStatCount.textContent = `${users.length} player${users.length === 1 ? '' : 's'}`;
    if (users.length === 0) {
      this.dom.playersEmpty.hidden = false;
      return;
    }
    this.dom.playersEmpty.hidden = true;
    for (const u of users) body.appendChild(this._renderPlayerRow(u));
  }

  _renderPlayerRow(u) {
    const tr = el('tr');
    tr.dataset.userId = u.id || u.userId;

    const handleCell = el('td', 'col-handle', escapeHtml(u.handle || '—'));
    tr.appendChild(handleCell);

    const ratingCell = el('td', 'col-rating');
    ratingCell.textContent = u.rating != null ? formatRating(u.rating, u.rd) : '—';
    tr.appendChild(ratingCell);

    tr.appendChild(el('td', 'col-games', String(u.gamesPlayed != null ? u.gamesPlayed : '—')));

    const statusCell = el('td', 'col-status');
    statusCell.appendChild(this._statusPill(u));
    tr.appendChild(statusCell);

    const actionsCell = el('td', 'col-actions');
    const bar = el('div', 'row-actions');

    const banned = !!u.banned;
    const banBtn = el('button', 'row-btn' + (banned ? '' : ' danger'), banned ? 'Unban' : 'Ban');
    banBtn.disabled = banned ? false : false;
    banBtn.addEventListener('click', () => this._toggleBan(u, banned));
    bar.appendChild(banBtn);

    const ratingBtn = el('button', 'row-btn', 'Rating');
    ratingBtn.addEventListener('click', () => this._adjustRatingPrompt(u));
    bar.appendChild(ratingBtn);

    actionsCell.appendChild(bar);
    tr.appendChild(actionsCell);
    return tr;
  }

  _statusPill(u) {
    if (u.banned) return el('span', 'status-pill banned', 'Banned');
    if (u.inGame) return el('span', 'status-pill in-game', 'In game');
    if (u.active) return el('span', 'status-pill active', 'Active');
    return el('span', 'status-pill idle', 'Idle');
  }

  async _toggleBan(u, currentlyBanned) {
    const action = currentlyBanned ? 'unban' : 'ban';
    const ok = await confirm({
      title: currentlyBanned ? `Unban ${u.handle}?` : `Ban ${u.handle}?`,
      message: currentlyBanned
        ? 'They will be able to play and queue again immediately.'
        : 'They will be kicked from any active game and unable to play until unbanned.',
      confirmLabel: currentlyBanned ? 'Unban' : 'Ban',
      cancelLabel: 'Cancel',
      danger: !currentlyBanned,
    });
    if (!ok) return;

    try {
      await this._api(`/admin/users/${encodeURIComponent(u.id || u.userId)}/${action}`, { method: 'POST' });
      toast({
        title: currentlyBanned ? 'User unbanned' : 'User banned',
        message: u.handle,
        kind: currentlyBanned ? 'good' : 'info',
      });
      await this.loadPlayers();
    } catch (err) {
      if (String(err.message).includes('Session expired')) return;
      toast({ title: 'Action failed', message: err.message, kind: 'bad' });
    }
  }

  async _adjustRatingPrompt(u) {
    const current = u.rating != null ? String(Math.round(u.rating)) : '1500';
    const body = el('div');
    body.innerHTML = `
      <p>Set a new rating for <strong>${escapeHtml(u.handle)}</strong>. This bypasses the normal rating system.</p>
      <div class="field" style="margin-top:14px">
        <label for="ratingInput">New rating</label>
        <input type="number" id="ratingInput" min="100" max="3500" step="1" value="${escapeHtml(current)}" />
      </div>`;
    const result = await modal({
      title: 'Adjust rating',
      body,
      actions: [
        { label: 'Cancel', value: null, kind: 'ghost' },
        { label: 'Save', value: 'save', kind: 'primary' },
      ],
    });
    if (result !== 'save') return;
    const input = $('ratingInput');
    const raw = input ? input.value : '';
    const val = parseInt(raw, 10);
    if (!Number.isFinite(val) || val < 100 || val > 3500) {
      toast({ title: 'Invalid rating', message: 'Pick a number between 100 and 3500.', kind: 'bad' });
      return;
    }
    const key = u.id || u.userId;
    if (this._ratingAdjustInFlight.has(key)) return;
    this._ratingAdjustInFlight.add(key);
    try {
      await this._api(`/admin/users/${encodeURIComponent(key)}/rating`, {
        method: 'POST',
        body: JSON.stringify({ rating: val }),
      });
      toast({ title: 'Rating updated', message: `${u.handle} → ${val}`, kind: 'good' });
      await this.loadPlayers();
    } catch (err) {
      if (String(err.message).includes('Session expired')) return;
      toast({ title: 'Update failed', message: err.message, kind: 'bad' });
    } finally {
      this._ratingAdjustInFlight.delete(key);
    }
  }

  async loadStats() {
    try {
      const data = await this._api('/admin/stats');
      this._queueLoaded = true;
      this._renderStats(data || {});
    } catch (err) {
      if (String(err.message).includes('Session expired')) return;
      this._renderStatsError(err);
    }
  }

  _renderStats(s) {
    const wrap = this.dom.queueStats;
    wrap.innerHTML = '';

    const cards = [
      { label: 'Queue depth', value: s.queueDepth != null ? s.queueDepth : 0, unit: 'waiting', trend: null },
      { label: 'Active games', value: s.activeGames != null ? s.activeGames : 0, unit: 'live', trend: null },
      { label: 'Total users', value: s.totalUsers != null ? s.totalUsers : 0, unit: 'all-time', trend: null },
      { label: 'Online now', value: s.onlineNow != null ? s.onlineNow : 0, unit: 'connected', trend: null },
    ];
    for (const c of cards) {
      const card = el('div', 'queue-card');
      card.innerHTML = `
        <p class="queue-card-label">${escapeHtml(c.label)}</p>
        <div class="queue-card-value">${c.value}<span class="unit">${escapeHtml(c.unit)}</span></div>`;
      wrap.appendChild(card);
    }

    const breakdown = s.queueByMode || s.queueBreakdown;
    if (breakdown && typeof breakdown === 'object') {
      const detail = el('div', 'queue-detail');
      const label = el('p', 'queue-detail-label', 'Queue by mode');
      detail.appendChild(label);
      const bars = el('div', 'queue-bars');
      const entries = Object.entries(breakdown);
      const max = entries.reduce((m, [, v]) => Math.max(m, Number(v) || 0), 0) || 1;
      for (const [mode, count] of entries) {
        const pct = Math.round(((Number(count) || 0) / max) * 100);
        const row = el('div', 'queue-bar');
        row.innerHTML = `
          <span class="queue-bar-name">${escapeHtml(mode)}</span>
          <span class="queue-bar-track"><span class="queue-bar-fill" style="width:${pct}%"></span></span>
          <span class="queue-bar-count">${Number(count) || 0}</span>`;
        bars.appendChild(row);
      }
      detail.appendChild(bars);
      wrap.appendChild(detail);
    }
  }

  _renderStatsError(err) {
    const wrap = this.dom.queueStats;
    wrap.innerHTML = '';
    const empty = el('div', 'empty-state');
    empty.style.gridColumn = '1 / -1';
    empty.innerHTML = `<h3>Stats unavailable</h3><p>${escapeHtml(err.message || 'Unknown error')}. <button class="link-btn" id="retryStats">Retry</button></p>`;
    wrap.appendChild(empty);
    const retry = $('retryStats');
    if (retry) retry.addEventListener('click', () => this.loadStats());
  }

  async loadLogs({ showSpinner = false } = {}) {
    if (showSpinner) {
      this.dom.logLoading.style.display = 'block';
      this.dom.logsEmpty.hidden = true;
    }
    try {
      const data = await this._api('/admin/logs');
      const logs = Array.isArray(data) ? data : (data && Array.isArray(data.events) ? data.events : []);
      this._logsLoaded = true;
      this._renderLogs(logs);
    } catch (err) {
      if (String(err.message).includes('Session expired')) return;
      this.dom.logBody.innerHTML = '';
      const row = el('tr');
      const cell = el('td');
      cell.colSpan = 4;
      cell.innerHTML = `<span class="toolbar-stat">Error: ${escapeHtml(err.message)}</span>`;
      row.appendChild(cell);
      this.dom.logBody.appendChild(row);
    } finally {
      this.dom.logLoading.style.display = 'none';
    }
  }

  _renderLogs(logs) {
    const body = this.dom.logBody;
    body.innerHTML = '';
    this.dom.logsStatCount.textContent = `${logs.length} event${logs.length === 1 ? '' : 's'}`;
    if (logs.length === 0) {
      this.dom.logsEmpty.hidden = false;
      return;
    }
    this.dom.logsEmpty.hidden = true;
    for (const l of logs) body.appendChild(this._renderLogRow(l));
  }

  _renderLogRow(l) {
    const tr = el('tr');
    const kind = this._logKind(l);

    const timeCell = el('td', 'col-time');
    const ts = l.timestamp || l.time || l.createdAt;
    const timeStr = typeof ts === 'number'
      ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '—';
    timeCell.innerHTML = `${escapeHtml(timeStr)}<span class="log-time-rel">${escapeHtml(formatRelativeTime(ts))}</span>`;
    tr.appendChild(timeCell);

    tr.appendChild(el('td', 'col-admin', escapeHtml(l.admin || l.adminHandle || 'system')));

    const actionCell = el('td', 'col-action');
    const action = el('span', `log-action ${kind}`);
    action.innerHTML = `<span class="ic" aria-hidden="true">${this._logIcon(kind)}</span><span>${escapeHtml(l.action || l.type || 'event')}</span>`;
    actionCell.appendChild(action);
    tr.appendChild(actionCell);

    const targetCell = el('td', 'col-target');
    const target = l.targetHandle || l.target || (l.targetUserId ? `#${l.targetUserId}` : '—');
    targetCell.innerHTML = `<span class="log-target-handle">${escapeHtml(target)}</span>`;
    tr.appendChild(targetCell);

    return tr;
  }

  _logKind(l) {
    const a = String(l.action || l.type || '').toLowerCase();
    if (a.includes('ban')) return 'ban';
    if (a.includes('prank') || a.includes('blunder') || a.includes('flip') || a.includes('silly') || a.includes('brilliancy')) return 'prank';
    if (a.includes('rating')) return 'prank';
    return '';
  }

  _logIcon(kind) {
    if (kind === 'ban') return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 L4 5 L4 11 C4 16 7 19 12 21 C17 19 20 16 20 11 L20 5 Z"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    if (kind === 'prank') return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 L13.5 8.5 L20 10 L13.5 11.5 L12 18 L10.5 11.5 L4 10 L10.5 8.5 Z"/></svg>';
    return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
  }

  _wirePrankPanel() {
    this.dom.prankClose.addEventListener('click', () => this.closePrankPanel());
    this.dom.prankScrim.addEventListener('click', () => this.closePrankPanel());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.dom.prankPanel.classList.contains('open')) {
        this.closePrankPanel();
      }
    });

    this.dom.prankGrid.addEventListener('click', (e) => {
      const btn = e.target.closest('.prank-btn');
      if (!btn) return;
      const prank = btn.dataset.prank;
      if (!prank) return;
      this._firePrank(prank, btn);
    });
  }

  openPrankPanel(game) {
    this.currentGameId = game.id || game.gameId;
    this.currentGame = game;
    this.gamesCache.forEach((g) => {});
    this.dom.page.querySelectorAll('.game-card').forEach((c) => {
      c.classList.toggle('active', c.dataset.gameId === String(this.currentGameId));
    });

    this._renderPrankGame(game);
    this._renderPrankTargets(game);
    this._renderPrankHistory(game);

    this.dom.prankPanel.classList.add('open');
    this.dom.prankPanel.setAttribute('aria-hidden', 'false');
    this.dom.prankScrim.hidden = false;
    requestAnimationFrame(() => this.dom.prankScrim.classList.add('show'));
  }

  closePrankPanel() {
    this.dom.prankPanel.classList.remove('open');
    this.dom.prankPanel.setAttribute('aria-hidden', 'true');
    this.dom.prankScrim.classList.remove('show');
    setTimeout(() => { this.dom.prankScrim.hidden = true; }, 320);
    this.dom.page.querySelectorAll('.game-card.active').forEach((c) => c.classList.remove('active'));
  }

  _renderPrankGame(game) {
    const wrap = this.dom.prankGame;
    wrap.innerHTML = '';
    const w = (game.white && game.white.handle) || 'White';
    const b = (game.black && game.black.handle) || 'Black';
    const row = el('div', 'prank-game-row');
    row.innerHTML = `
      <div class="prank-game-vs">
        <span class="handle">${escapeHtml(w)}</span>
        <span class="sep">vs</span>
        <span class="handle">${escapeHtml(b)}</span>
      </div>
      <span class="prank-game-id">#${escapeHtml(String(game.id || game.gameId || '').slice(0, 8))}</span>`;
    wrap.appendChild(row);
  }

  _renderPrankTargets(game) {
    const wrap = this.dom.prankTargetOptions;
    wrap.innerHTML = '';
    const sides = [
      { key: 'white', p: game.white, color: 'w', label: 'White' },
      { key: 'black', p: game.black, color: 'b', label: 'Black' },
    ].filter((s) => s.p && (s.p.id || s.p.userId || s.p.handle));

    if (sides.length === 0) {
      this.dom.prankTargetBlock.hidden = true;
      this.currentTargetId = null;
      return;
    }
    this.dom.prankTargetBlock.hidden = false;

    if (!sides.some((s) => (s.p.id || s.p.userId) === this.currentTargetId)) {
      this.currentTargetId = sides[0].p.id || sides[0].p.userId;
    }

    for (const s of sides) {
      const id = s.p.id || s.p.userId;
      const opt = el('button', 'prank-target-opt');
      opt.type = 'button';
      opt.setAttribute('role', 'radio');
      opt.setAttribute('aria-checked', String(id === this.currentTargetId));
      opt.innerHTML = `
        <span class="dot ${s.color}" aria-hidden="true"></span>
        <span class="handle">${escapeHtml(s.p.handle || s.label)}</span>
        <span class="rating">${escapeHtml(s.p.rating != null ? formatRating(s.p.rating, s.p.rd) : '—')}</span>`;
      opt.addEventListener('click', () => {
        this.currentTargetId = id;
        wrap.querySelectorAll('.prank-target-opt').forEach((o) => o.setAttribute('aria-checked', 'false'));
        opt.setAttribute('aria-checked', 'true');
      });
      wrap.appendChild(opt);
    }
  }

  _renderPrankHistory(game) {
    const wrap = this.dom.prankHistory;
    wrap.innerHTML = '';
    const events = (game && Array.isArray(game.prankHistory)) ? game.prankHistory : [];
    if (events.length === 0) {
      wrap.appendChild(el('p', 'prank-history-empty', 'No pranks sent to this game yet.'));
      return;
    }
    const recent = events.slice(-8).reverse();
    for (const ev of recent) {
      const prank = ev.prank || ev.type || '';
      const label = PRANK_LABELS[prank] || prank || 'prank';
      const item = el('div', 'prank-history-item ' + this._prankHistoryClass(prank));
      const target = ev.targetHandle || (game.white && game.white.handle) || '';
      const rel = formatRelativeTime(ev.timestamp || ev.time);
      item.innerHTML = `
        <span class="ic" aria-hidden="true">${PRANK_HISTORY_ICONS[prank] || PRANK_HISTORY_ICONS.force_blunder}</span>
        <div class="prank-history-item-text">
          <div class="prank-history-item-action">${escapeHtml(label)}</div>
          <div class="prank-history-item-meta">${escapeHtml(target ? `→ ${target}` : '')}</div>
        </div>
        <span class="prank-history-item-time">${escapeHtml(rel)}</span>`;
      wrap.appendChild(item);
    }
  }

  _prankHistoryClass(prank) {
    if (prank === 'fake_ban') return 'ban';
    if (prank === 'stockfish_mode') return 'self';
    return '';
  }

  async _firePrank(prank, btn) {
    if (!this.currentGameId) {
      toast({ title: 'No game selected', message: 'Open a live game first.', kind: 'bad' });
      return;
    }
    const isSelf = prank === 'stockfish_mode';
    if (!isSelf && !this.currentTargetId) {
      toast({ title: 'Pick a target', message: 'Choose which player to prank.', kind: 'info' });
      return;
    }

    const label = PRANK_LABELS[prank] || prank;
    const danger = prank === 'fake_ban';
    const ok = await confirm({
      title: `Send "${label}"?`,
      message: this._prankConfirmMessage(prank),
      confirmLabel: 'Send it',
      cancelLabel: 'Cancel',
      danger,
    });
    if (!ok) return;

    btn.classList.add('sending');
    btn.disabled = true;
    try {
      await this._api(`/admin/games/${encodeURIComponent(this.currentGameId)}/prank`, {
        method: 'POST',
        body: JSON.stringify({ prank, targetUserId: isSelf ? null : this.currentTargetId }),
      });
      toast({
        title: `${label} deployed`,
        message: isSelf ? 'Activated for your board.' : 'Targeted and in effect.',
        kind: 'good',
      });
      await this.loadGames();
      await this.loadLogs();
      const fresh = this.gamesCache.find((g) => String(g.id || g.gameId) === String(this.currentGameId));
      if (fresh) {
        this.currentGame = fresh;
        this._renderPrankHistory(fresh);
      }
    } catch (err) {
      if (String(err.message).includes('Session expired')) return;
      toast({ title: 'Prank failed', message: err.message, kind: 'bad' });
    } finally {
      btn.classList.remove('sending');
      btn.disabled = false;
    }
  }

  _prankConfirmMessage(prank) {
    switch (prank) {
      case 'force_blunder': return 'Their next legal move will be picked from the worst available. One-shot.';
      case 'board_flip': return 'Their board orientation flips at a random moment this turn.';
      case 'silly_pieces': return 'Pieces render as novelty glyphs for 10 seconds, then snap back.';
      case 'fake_brilliancy': return 'Their next move gets a "Brilliant!!" callout, regardless of quality.';
      case 'stockfish_mode': return 'Reveals best-move arrows on YOUR board only. Opponent sees nothing.';
      case 'choose_moves': return 'You will be prompted to pick their next move from legal options.';
      case 'fake_ban': return 'They will see a ban screen, then a "Just kidding!" reveal after 4 seconds.';
      default: return 'This will affect the targeted player\'s current game.';
    }
  }

  _wireVisibility() {
    document.addEventListener('visibilitychange', () => {
      this.visible = !document.hidden;
      if (this.visible) {
        if (this.token && !this.dom.page.hidden) {
          this.startPolling();
          this.loadAll();
        }
      } else {
        this.stopPolling();
      }
    });
    window.addEventListener('online', () => {
      if (this.token && !this.dom.page.hidden) {
        this.startPolling();
        this.loadAll();
      }
    });
    window.addEventListener('offline', () => {
      this.stopPolling();
      if (this.dom.livePulse) this.dom.livePulse.classList.add('paused');
    });
  }

  startPolling() {
    this.stopPolling();
    if (!this.token) return;
    this.polling = true;
    if (this.dom.livePulse) this.dom.livePulse.classList.remove('paused');
    this.timers.games = setInterval(() => {
      if (this.visible && this.activeTab === 'games') this.loadGames();
    }, POLL_GAMES_MS);
    this.timers.queue = setInterval(() => {
      if (this.visible && (this.activeTab === 'queue' || this.activeTab === 'games')) this.loadStats();
    }, POLL_QUEUE_MS);
  }

  stopPolling() {
    this.polling = false;
    if (this.timers.games) { clearInterval(this.timers.games); this.timers.games = null; }
    if (this.timers.queue) { clearInterval(this.timers.queue); this.timers.queue = null; }
  }
}

const panel = new AdminPanel();
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => panel.init());
} else {
  panel.init();
}

export { AdminPanel };
