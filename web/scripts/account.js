import { store } from './play/store.js';
import {
  toast, modal, confirm, formatRating, formatRelativeTime, formatAccuracy, pieceSvg,
} from './ui.js';

const FALLBACK_OPENINGS = ['Italian Game', 'Sicilian Defense', 'French Defense', "Queen's Gambit", 'Ruy Lopez'];
const FORM_DOT_COUNT = 10;
const PROVISIONAL_RD = 100;
const UP_ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="18 15 12 9 6 15"/></svg>';
const DOWN_ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
const CHEV_DOWN = '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
const REFRESH_IC = '<svg class="ic-refresh" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';
const SPARKLE_IC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>';
const KNIGHT_IC = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 22H5v-2h14v2zM13 2v2c4 1 6 4 6 8v3l1 2v2H4v-2l1-2v-2.5c0-1.7.8-3.2 2-4.2L9 9c0-1 .5-2 1.5-2.5L13 2z"/></svg>';
const INFO_IC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html != null) node.innerHTML = html;
  return node;
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function setText(id, text) {
  const node = document.getElementById(id);
  if (node) node.textContent = text == null ? '' : String(text);
}

function setHtml(id, html) {
  const node = document.getElementById(id);
  if (node) node.innerHTML = html == null ? '' : String(html);
}

function formatMemberSince(ts) {
  if (!ts) return 'Member';
  try {
    const d = new Date(ts);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `Member since ${months[d.getMonth()]} ${d.getFullYear()}`;
  } catch (e) {
    return 'Member';
  }
}

function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—';
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function moveCount(game) {
  if (Array.isArray(game.moves)) return game.moves.length;
  if (typeof game.moveCount === 'number') return game.moveCount;
  return 0;
}

function openingName(game) {
  if (game.opening) return game.opening;
  if (game.ecoName) return game.ecoName;
  return null;
}

function timeControl(game) {
  if (game.timeControl) return game.timeControl;
  if (game.tc) return game.tc;
  return null;
}

function userRatingAfter(game, fallback) {
  if (typeof game.userRatingAfter === 'number') return game.userRatingAfter;
  if (typeof game.ratingAfter === 'number') return game.ratingAfter;
  if (typeof game.estimatedElo === 'number') return game.estimatedElo;
  return fallback;
}

function resultChar(result) {
  if (result === 'win') return 'W';
  if (result === 'loss') return 'L';
  if (result === 'draw') return 'D';
  return '?';
}

function accuracyClass(acc) {
  if (typeof acc !== 'number' || !Number.isFinite(acc)) return '';
  if (acc >= 90) return 'good';
  if (acc >= 75) return 'mid';
  return 'low';
}

class AccountPage {
  constructor() {
    this.user = null;
    this.stats = null;
    this.filter = '';
    this.sort = 'date';
    this.tabsLoaded = { games: false, leaderboard: false, insights: false };
    this._resetConfirming = false;
    this._syncing = false;
    this._expandedRow = null;
  }

  _currentUser() {
    try {
      const live = store.getUser();
      if (live) {
        this.user = live;
        return live;
      }
    } catch (e) {}
    return this.user || { handle: 'Guest', rating: 1200, gamesPlayed: 0 };
  }

  async init() {
    this.bindNav();
    this.bindYear();

    try {
      this.user = store.ensureUser();
    } catch (e) {
      console.error('Failed to ensure user', e);
      this.user = store.getUser() || { handle: 'Guest', rating: 1200, gamesPlayed: 0 };
    }
    this.renderProfile(this.user);

    try {
      this.stats = store.getStats();
    } catch (e) {
      this.stats = { gamesPlayed: 0, wins: 0, losses: 0, draws: 0, currentStreak: 0, bestStreak: 0, averageAccuracy: 0, lastPlayedAt: null };
    }
    this.renderStats(this.stats);

    this.setupTabs();
    this.setupProfileActions();
    this.setupGamesToolbar();
    this.setupLeaderboardToolbar();
    this.tabsLoaded.games = true;

    await this.renderGames();

    setTimeout(() => this.positionTabUnderline(), 0);
    setTimeout(() => this.positionTabUnderline(), 200);

    this.syncWithServer();
  }

  async syncWithServer() {
    if (this._syncing) return;
    this._syncing = true;
    this.setSyncState('syncing');

    try {
      const res = await store.syncToServer();
      try { this.user = store.getUser() || this.user; } catch (_) {}
      if (res && res.status === 'synced') {
        this.setSyncState('synced', res.synced || 0);
        this.renderProfile(this.user);
        if (res.synced > 0) {
          toast({
            title: 'Synced to server',
            message: `${res.synced} game${res.synced === 1 ? '' : 's'} uploaded.`,
            kind: 'good',
            duration: 3500,
          });
        }
      } else {
        this.setSyncState('offline', res && res.error);
      }
    } catch (err) {
      this.setSyncState('offline', err && err.message);
    } finally {
      this._syncing = false;
    }
  }

  setSyncState(state, detail) {
    const badge = document.getElementById('syncBadge');
    if (!badge) return;
    badge.classList.remove('syncing', 'synced', 'offline');
    badge.classList.add(state);
    const text = badge.querySelector('.sync-text');
    if (!text) return;
    if (state === 'syncing') text.textContent = 'Syncing…';
    else if (state === 'synced') {
      const n = typeof detail === 'number' ? detail : 0;
      text.textContent = n > 0 ? `Synced · ${n} new` : 'Synced';
    } else {
      text.textContent = 'Offline · local only';
    }
  }

  bindNav() {
    const nav = document.getElementById('nav');
    if (nav) {
      const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 24);
      window.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
    }
    const toggle = document.getElementById('menuToggle');
    const menu = document.getElementById('mobileMenu');
    if (toggle && menu) {
      toggle.addEventListener('click', () => {
        const open = toggle.getAttribute('aria-expanded') === 'true';
        toggle.setAttribute('aria-expanded', String(!open));
        menu.classList.toggle('open', !open);
      });
      menu.querySelectorAll('a').forEach((a) => {
        a.addEventListener('click', () => {
          toggle.setAttribute('aria-expanded', 'false');
          menu.classList.remove('open');
        });
      });
    }
  }

  bindYear() {
    const y = document.getElementById('year');
    if (y) y.textContent = new Date().getFullYear();
  }

  renderProfile(user) {
    const u = user || {};
    const avatar = document.getElementById('avatar');
    if (avatar) {
      avatar.innerHTML = pieceSvg('w', 'k');
    }
    setText('handle', u.handle || 'Anonymous');
    setText('memberSince', formatMemberSince(u.createdAt));

    const rating = typeof u.rating === 'number' ? u.rating : 1200;
    const rd = u.ratingVolatility != null ? u.ratingVolatility : u.ratingRd;
    setText('ratingNum', String(Math.round(rating)));
    setText('ratingRd', rd != null ? `± ${Math.round(rd)}` : '');

    const prov = document.getElementById('ratingProv');
    if (prov) {
      const isProv = typeof rd === 'number' && rd > PROVISIONAL_RD;
      prov.hidden = !isProv;
    }
  }

  renderStats(stats) {
    const s = stats || {};
    setText('statGames', s.gamesPlayed != null ? s.gamesPlayed : 0);
    setText('statAcc', this.formatAvgAccuracy(s));
    setText('statStreak', this.formatStreak(s));
    this.renderRatioBar(s);
    this.renderFormDots(s);
    this.renderAccuracyTrend(s);
  }

  renderRatioBar(s) {
    const bar = document.getElementById('ratioBar');
    const legend = document.getElementById('ratioLegend');
    if (!bar || !legend) return;

    const w = s.wins || 0;
    const d = s.draws || 0;
    const l = s.losses || 0;
    const total = w + d + l;

    bar.innerHTML = '';
    if (total === 0) {
      bar.innerHTML = '<div class="ratio-seg draw" style="flex-grow: 1;"></div>';
      legend.innerHTML = '<span class="form-empty">No games yet</span>';
      return;
    }

    const segs = [
      { kind: 'win', count: w },
      { kind: 'draw', count: d },
      { kind: 'loss', count: l },
    ].filter((x) => x.count > 0);

    segs.forEach((seg) => {
      const node = el('div', `ratio-seg ${seg.kind}`);
      node.style.flexGrow = String(seg.count);
      node.setAttribute('title', `${seg.kind}: ${seg.count}`);
      bar.appendChild(node);
    });

    const pct = (n) => total > 0 ? Math.round((n / total) * 100) : 0;
    legend.innerHTML = '';
    [['win', w], ['draw', d], ['loss', l]].forEach(([kind, count]) => {
      const lg = el('span', `lg ${kind}`);
      lg.innerHTML = `<span class="sw" aria-hidden="true"></span><span>${kind[0].toUpperCase()}${kind.slice(1)}</span><span class="v">${count}</span><span style="opacity:0.6">·</span><span>${pct(count)}%</span>`;
      legend.appendChild(lg);
    });
  }

  renderFormDots(s) {
    const wrap = document.getElementById('formDots');
    if (!wrap) return;

    let games = [];
    try { games = store.getGames(); } catch (e) { games = []; }
    const recent = games.slice(0, FORM_DOT_COUNT);

    wrap.innerHTML = '';
    if (recent.length === 0) {
      wrap.appendChild(el('span', 'form-empty', 'No games yet'));
      return;
    }

    recent.forEach((g) => {
      const dot = el('span', `dot ${g.result || 'draw'}`);
      dot.setAttribute('title', `${resultChar(g.result)} · ${formatRelativeTime(g.endedAt || g.startedAt)}`);
      wrap.appendChild(dot);
    });
    for (let i = recent.length; i < FORM_DOT_COUNT; i++) {
      wrap.appendChild(el('span', 'dot pending', ''));
    }
  }

  renderAccuracyTrend(s) {
    const node = document.getElementById('statAccTrend');
    if (!node) return;

    const overall = s.averageAccuracy;
    if (typeof overall !== 'number' || !Number.isFinite(overall) || overall <= 0) {
      node.hidden = true;
      return;
    }

    let games = [];
    try { games = store.getGames(); } catch (e) { games = []; }
    const last10 = games.slice(0, 10).filter((g) => typeof g.accuracy === 'number' && isFinite(g.accuracy));
    if (last10.length === 0) {
      node.hidden = true;
      return;
    }
    const recentAvg = last10.reduce((a, g) => a + g.accuracy, 0) / last10.length;
    const diff = recentAvg - overall;
    const abs = Math.abs(diff);

    node.hidden = false;
    node.classList.remove('up', 'down', 'flat');
    let arrow = '';
    if (abs < 0.5) {
      node.classList.add('flat');
      arrow = '—';
    } else if (diff > 0) {
      node.classList.add('up');
      arrow = UP_ARROW;
    } else {
      node.classList.add('down');
      arrow = DOWN_ARROW;
    }
    node.innerHTML = `${arrow}<span>${abs >= 0.5 ? abs.toFixed(1) + '%' : '0.0%'}</span>`;
    node.setAttribute('title', `Last 10 avg ${recentAvg.toFixed(1)}% vs overall ${overall.toFixed(1)}%`);
  }

  formatAvgAccuracy(s) {
    const a = s.averageAccuracy;
    if (typeof a !== 'number' || !Number.isFinite(a) || a <= 0) return '—';
    return `${a.toFixed(1)}%`;
  }

  formatStreak(s) {
    const c = s.currentStreak;
    if (typeof c !== 'number' || c === 0) return '0';
    const sign = c > 0 ? '+' : '';
    return `${sign}${c}`;
  }

  async renderGames(filter, sort) {
    const list = document.getElementById('gamesList');
    if (!list) return;

    this._renderSkeletons(list, 4);

    await new Promise((r) => setTimeout(r, 120));

    let games = [];
    try {
      games = store.getGames({ result: filter || undefined });
    } catch (e) {
      games = [];
    }
    if (!Array.isArray(games)) games = [];

    games = this._sortGames(games, sort || this.sort);

    list.innerHTML = '';
    this._expandedRow = null;

    if (games.length === 0) {
      list.appendChild(el('div', 'empty games-empty', `
        <h3>${this.filter ? 'No matching games' : 'No games yet'}</h3>
        <p>${this.filter ? 'Try a different filter.' : 'Play a game to start building your history.'}</p>
      `));
      return;
    }

    for (const g of games) {
      list.appendChild(this.renderGameRow(g));
    }
  }

  _sortGames(games, sort) {
    const arr = games.slice();
    if (sort === 'accuracy-high') {
      arr.sort((a, b) => (b.accuracy || -1) - (a.accuracy || -1));
    } else if (sort === 'accuracy-low') {
      arr.sort((a, b) => (a.accuracy == null ? 999 : a.accuracy) - (b.accuracy == null ? 999 : b.accuracy));
    } else {
      arr.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    }
    return arr;
  }

  _renderSkeletons(container, count) {
    container.innerHTML = '';
    for (let i = 0; i < count; i++) {
      container.appendChild(el('div', 'skeleton skel-row', ''));
    }
  }

  renderGameRow(game) {
    const row = el('div', 'game-row');
    row.dataset.id = game.id || '';

    const head = el('div', 'game-row-head');
    head.setAttribute('role', 'button');
    head.setAttribute('tabindex', '0');
    head.setAttribute('aria-expanded', 'false');

    const result = game.result || 'draw';
    const badge = el('div', `result-badge ${result}`, resultChar(result));

    const main = el('div', 'game-main');
    const oppWrap = el('div', 'game-opp');
    oppWrap.appendChild(el('span', 'opp-name', escapeHtml(game.opponentName || 'Unknown')));
    if (game.opponentRating != null) {
      oppWrap.appendChild(el('span', 'opp-rating', `(${Math.round(game.opponentRating)})`));
    }
    if (game.opponentKind) {
      oppWrap.appendChild(el('span', 'opp-kind', escapeHtml(game.opponentKind)));
    }
    main.appendChild(oppWrap);

    const sub = el('div', 'game-sub');
    const opening = openingName(game);
    if (opening) {
      sub.appendChild(el('span', 'opening', escapeHtml(opening)));
      sub.appendChild(el('span', 'dot', '·'));
    }
    sub.appendChild(el('span', 'moves', `${moveCount(game)} moves`));
    const tc = timeControl(game);
    if (tc) {
      sub.appendChild(el('span', 'dot', '·'));
      sub.appendChild(el('span', null, escapeHtml(tc)));
    }
    main.appendChild(sub);

    const accStat = el('div', 'game-stat');
    accStat.appendChild(el('span', `stat-v acc ${accuracyClass(game.accuracy)}`, formatAccuracy(game.accuracy)));
    accStat.appendChild(el('span', 'stat-k', 'accuracy'));
    const dateStat = el('div', 'game-stat date');
    const ts = game.endedAt != null ? game.endedAt : game.startedAt;
    dateStat.appendChild(el('span', 'stat-v', formatRelativeTime(ts)));
    dateStat.appendChild(el('span', 'stat-k', 'played'));

    const chev = el('span', null, CHEV_DOWN);

    head.appendChild(badge);
    head.appendChild(main);
    head.appendChild(accStat);
    head.appendChild(dateStat);
    head.appendChild(chev);

    const statsMobile = el('div', 'stats-mobile');
    statsMobile.style.display = 'none';
    head.appendChild(statsMobile);

    const detail = el('div', 'game-detail');
    detail.appendChild(this._renderGameDetailInner(game));
    row.appendChild(head);
    row.appendChild(detail);

    const toggle = () => this._toggleRow(row, head);
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });

    return row;
  }

  _renderGameDetailInner(game) {
    const inner = el('div', 'game-detail-inner');

    const you = this.user && this.user.handle ? this.user.handle : 'You';
    const opp = game.opponentName || 'Unknown';
    const white = game.color === 'b' ? opp : you;
    const black = game.color === 'b' ? you : opp;

    const meta = el('div', 'detail-meta');
    const kv = (k, v) => {
      const wrap = el('span', 'kv');
      wrap.appendChild(el('span', 'k', k));
      wrap.appendChild(el('span', null, v));
      return wrap;
    };
    meta.appendChild(kv('white', escapeHtml(white)));
    meta.appendChild(kv('black', escapeHtml(black)));
    meta.appendChild(kv('result', escapeHtml((game.result || 'draw').toUpperCase())));
    if (openingName(game)) meta.appendChild(kv('opening', escapeHtml(openingName(game))));
    meta.appendChild(kv('moves', String(moveCount(game))));
    if (game.accuracy != null) meta.appendChild(kv('acc', formatAccuracy(game.accuracy)));
    if (game.durationMs != null) meta.appendChild(kv('time', formatDuration(game.durationMs)));
    if (timeControl(game)) meta.appendChild(kv('tc', escapeHtml(timeControl(game))));
    inner.appendChild(meta);

    const pgn = game.pgn || '(no PGN stored for this game)';
    inner.appendChild(el('pre', 'detail-pgn', escapeHtml(pgn)));

    return inner;
  }

  _toggleRow(row, head) {
    if (this._expandedRow && this._expandedRow !== row) {
      this._expandedRow.classList.remove('expanded');
      const eh = this._expandedRow.querySelector('.game-row-head');
      if (eh) { eh.setAttribute('aria-expanded', 'false'); }
    }
    const isOpen = row.classList.toggle('expanded');
    head.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    this._expandedRow = isOpen ? row : null;
  }

  setupGamesToolbar() {
    const filter = document.getElementById('filterResult');
    if (filter) {
      filter.addEventListener('change', () => {
        this.filter = filter.value;
        this.renderGames(this.filter, this.sort);
      });
    }
    const sortSel = document.getElementById('sortBy');
    if (sortSel) {
      sortSel.addEventListener('change', () => {
        this.sort = sortSel.value;
        this.renderGames(this.filter, this.sort);
      });
    }
    const exportBtn = document.getElementById('exportBtn');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => this.exportPgns());
    }
  }

  exportPgns() {
    let games = [];
    try { games = store.getGames(); } catch (e) { games = []; }
    const pgns = games
      .filter((g) => g && typeof g.pgn === 'string' && g.pgn.length > 0)
      .map((g) => g.pgn.trim());

    if (pgns.length === 0) {
      toast({
        title: 'Nothing to export',
        message: 'You have no games with PGN data yet.',
        kind: 'bad',
      });
      return;
    }

    const blob = new Blob([pgns.join('\n\n')], { type: 'application/x-chess-pgn' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `chessright-${stamp}.pgn`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      if (a.parentNode) a.parentNode.removeChild(a);
    }, 0);

    toast({
      title: 'Exported',
      message: `${pgns.length} PGN${pgns.length === 1 ? '' : 's'} downloaded.`,
      kind: 'good',
    });
  }

  setupTabs() {
    const bar = document.querySelector('.tab-bar');
    const tabs = Array.from(document.querySelectorAll('.tab'));
    const panels = Array.from(document.querySelectorAll('.tab-panel'));

    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const name = tab.dataset.tab;
        if (!name) return;
        tabs.forEach((t) => {
          const on = t === tab;
          t.classList.toggle('on', on);
          t.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        panels.forEach((p) => {
          p.classList.toggle('on', p.dataset.panel === name);
        });
        this.positionTabUnderline();
        this.onTabShown(name);
      });
    });

    if (bar) {
      const ro = new ResizeObserver(() => this.positionTabUnderline());
      ro.observe(bar);
    }
    window.addEventListener('resize', () => this.positionTabUnderline());
  }

  positionTabUnderline() {
    const active = document.querySelector('.tab.on');
    const underline = document.getElementById('tabUnderline');
    const bar = document.querySelector('.tab-bar');
    if (!active || !underline || !bar) return;
    const barRect = bar.getBoundingClientRect();
    const r = active.getBoundingClientRect();
    underline.style.width = `${r.width}px`;
    underline.style.transform = `translateX(${r.left - barRect.left - 5}px)`;
  }

  onTabShown(name) {
    if (name === 'leaderboard' && !this.tabsLoaded.leaderboard) {
      this.tabsLoaded.leaderboard = true;
      this.loadLeaderboard();
    } else if (name === 'insights' && !this.tabsLoaded.insights) {
      this.tabsLoaded.insights = true;
      this.renderInsights();
    }
  }

  setupLeaderboardToolbar() {
    const refresh = document.getElementById('lbRefresh');
    if (refresh) {
      refresh.addEventListener('click', () => this.loadLeaderboard(true));
    }
  }

  async loadLeaderboard(force) {
    const target = document.getElementById('leaderboard');
    if (!target) return;

    const banner = document.getElementById('lbRankBanner');
    this._renderLbSkeleton(target);

    let serverRows = null;
    if (this.user && (this.user.syncState === 'synced' || force)) {
      try {
        serverRows = await store.fetchLeaderboard(100);
      } catch (e) {
        serverRows = null;
      }
    }

    if (serverRows && serverRows.length > 0) {
      this._renderRankBanner(banner, serverRows, true);
      this.renderLeaderboard(target, serverRows, 'server');
    } else {
      const rows = this._localLeaderboard();
      this._renderRankBanner(banner, rows, false);
      this.renderLeaderboard(target, rows, 'local');
    }
  }

  _renderLbSkeleton(container) {
    container.innerHTML = '';
    const header = el('div', 'lb-header');
    header.appendChild(el('span', 'col-rank', 'Rank'));
    header.appendChild(el('span', 'col-handle', 'Handle'));
    header.appendChild(el('span', 'col-rating', 'Rating'));
    header.appendChild(el('span', 'col-games', 'Games'));
    container.appendChild(header);
    for (let i = 0; i < 6; i++) {
      const row = el('div', 'lb-skel-row');
      row.innerHTML = '<div class="s skeleton" style="width:30px;"></div><div class="s skeleton" style="width:60%;"></div><div class="s skeleton" style="width:50px;"></div><div class="s skeleton" style="width:30px;"></div>';
      container.appendChild(row);
    }
  }

  _renderRankBanner(banner, rows, isServer) {
    if (!banner) return;
    const myId = this.user && (this.user.serverId || this.user.id);
    const games = (this.stats && this.stats.gamesPlayed) || 0;

    if (games < 5) {
      banner.hidden = false;
      banner.classList.remove('off');
      banner.classList.add('off');
      banner.innerHTML = `${INFO_IC}<span class="lbl">Play <strong style="color:var(--ink);">${5 - games} more</strong> to enter the leaderboard</span>`;
      return;
    }

    const me = rows.find((r) => r.isMe || (myId && r.userId === myId) || (r.handle === this.user.handle));
    if (me && typeof me.rank === 'number' && me.rank > 0) {
      banner.hidden = false;
      banner.classList.remove('off');
      banner.innerHTML = `<span class="lbl">Your rank</span><span class="rk">#${me.rank}</span><span class="lbl" style="opacity:0.6;">of ${rows.length}</span>`;
    } else {
      banner.hidden = false;
      banner.classList.add('off');
      banner.innerHTML = `${INFO_IC}<span class="lbl">Not ranked yet — keep playing to climb</span>`;
    }
  }

  _localLeaderboard() {
    const me = {
      rank: 1, handle: (this.user && this.user.handle) || 'You',
      rating: Math.round((this.user && this.user.rating) || 1200),
      games: (this.stats && this.stats.gamesPlayed) || 0,
      isMe: true,
    };

    const circle = [];
    const seen = new Set();
    try {
      const games = store.getGames();
      for (const g of games) {
        const key = `${g.opponentKind || 'bot'}:${g.opponentName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!g.opponentName) continue;
        circle.push({
          rank: 0, handle: g.opponentName,
          rating: Math.round(g.opponentRating || 1200),
          games: 1, isMe: false,
        });
      }
    } catch (e) {}

    circle.push(me);
    circle.sort((a, b) => b.rating - a.rating);
    circle.forEach((r, i) => { r.rank = i + 1; });
    return circle;
  }

  renderLeaderboard(target, rows, source) {
    target.innerHTML = '';

    const header = el('div', 'lb-header');
    header.appendChild(el('span', 'col-rank', 'Rank'));
    header.appendChild(el('span', 'col-handle', 'Handle'));
    header.appendChild(el('span', 'col-rating', 'Rating'));
    header.appendChild(el('span', 'col-games', 'Games'));
    target.appendChild(header);

    if (!rows || rows.length === 0) {
      const empty = el('div', 'empty');
      empty.style.borderRadius = '0';
      empty.innerHTML = '<h3>No entries</h3><p>Be the first to claim a spot.</p>';
      target.appendChild(empty);
      return;
    }

    const myId = this.user && (this.user.serverId || this.user.id);
    const myHandle = this.user && this.user.handle;

    rows.slice(0, 100).forEach((r) => {
      const isMe = r.isMe || (myId && r.userId === myId) || (myHandle && r.handle === myHandle);
      const row = el('div', `lb-row${isMe ? ' me' : ''}`);
      row.appendChild(el('span', `lb-rank${r.rank <= 3 ? ' top' : ''}`, `#${r.rank}`));
      const handleCell = el('span', 'lb-handle');
      handleCell.appendChild(el('span', 'h-text', escapeHtml(r.handle || 'Anonymous')));
      if (isMe) {
        handleCell.appendChild(el('span', 'me-tag', 'you'));
      }
      row.appendChild(handleCell);
      row.appendChild(el('span', 'lb-rating', String(r.rating)));
      row.appendChild(el('span', 'lb-games', String(r.games || 0)));
      target.appendChild(row);
    });

    const oldNote = target.parentNode.querySelector('.lb-note');
    if (oldNote) oldNote.remove();

    if (source === 'local') {
      const note = el('div', 'lb-note');
      note.innerHTML = `${INFO_IC}<span>Showing opponents you have played locally. <a href="play.html">Play more games</a> to fill out your circle.</span>`;
      target.parentNode.insertBefore(note, target.nextSibling);
    }
  }

  renderInsights() {
    let games = [];
    try { games = store.getGames(); } catch (e) { games = []; }

    this.drawRatingChart(games);
    this.renderOpenings(games);
    this.drawTcChart(games);
    this.renderMistakes();
  }

  drawRatingChart(games) {
    const wrap = document.getElementById('ratingChart');
    if (!wrap) return;
    wrap.innerHTML = '';

    const baseRating = (this.user && this.user.rating) || 1200;
    const points = [];
    for (const g of games) {
      const ts = g.endedAt != null ? g.endedAt : g.startedAt;
      if (!ts) continue;
      points.push({ ts, rating: Math.round(userRatingAfter(g, baseRating)) });
    }
    points.sort((a, b) => a.ts - b.ts);

    if (points.length === 0) {
      wrap.appendChild(this._insightEmpty({
        glyph: SPARKLE_IC,
        title: 'No rating history yet',
        body: 'Your rating trajectory will appear here after your first few games. Every match shapes the curve.',
        cta: { label: 'Play a game', href: 'play.html' },
      }));
      return;
    }

    if (points.length === 1) {
      points.unshift({ ts: points[0].ts - 1000, rating: baseRating });
    }

    const W = 600, H = 140, padX = 10, padY = 18;
    const ratings = points.map((p) => p.rating);
    let minR = Math.min(...ratings);
    let maxR = Math.max(...ratings);
    if (minR === maxR) { minR -= 25; maxR += 25; }
    const span = Math.max(1, maxR - minR);
    const pad = span * 0.1;
    minR -= pad; maxR += pad;

    const n = points.length;
    const xAt = (i) => n <= 1 ? padX : padX + (i / (n - 1)) * (W - padX * 2);
    const yAt = (r) => H - padY - ((r - minR) / (maxR - minR)) * (H - padY * 2);

    const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i).toFixed(2)} ${yAt(p.rating).toFixed(2)}`).join(' ');
    const fillPath = `${linePath} L ${xAt(n - 1).toFixed(2)} ${H - padY} L ${xAt(0).toFixed(2)} ${H - padY} Z`;

    const last = points[points.length - 1].rating;
    const lastX = xAt(n - 1);
    const lastY = yAt(last);

    const maxIdx = ratings.indexOf(Math.max(...ratings));
    const minIdx = ratings.indexOf(Math.min(...ratings));

    const grad = `cr-rate-${Math.random().toString(36).slice(2, 8)}`;
    const gridLines = [0.25, 0.5, 0.75].map((f) => {
      const y = padY + f * (H - padY * 2);
      return `<line x1="${padX}" y1="${y.toFixed(2)}" x2="${W - padX}" y2="${y.toFixed(2)}" stroke="rgba(255,255,255,0.04)" stroke-width="1"/>`;
    }).join('');

    const marker = (idx, color, label) => {
      if (idx < 0 || idx >= points.length) return '';
      const x = xAt(idx);
      const y = yAt(points[idx].rating);
      return `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="3" fill="${color}" stroke="#08080c" stroke-width="1.2"/><text x="${x.toFixed(2)}" y="${(y - 7).toFixed(2)}" text-anchor="middle" fill="${color}" font-family="JetBrains Mono, monospace" font-size="9" font-weight="600">${label}</text>`;
    };

    const svg = `
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Rating over time, ${n} points, range ${Math.round(minR)} to ${Math.round(maxR)}">
        <defs>
          <linearGradient id="${grad}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#d4af37" stop-opacity="0.4"/>
            <stop offset="100%" stop-color="#d4af37" stop-opacity="0"/>
          </linearGradient>
        </defs>
        ${gridLines}
        <path d="${fillPath}" fill="url(#${grad})" stroke="none"/>
        <path d="${linePath}" fill="none" stroke="#f3d678" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
        ${marker(maxIdx, '#7ac35f', 'HI')}
        ${marker(minIdx, '#e05656', 'LO')}
        <circle cx="${lastX.toFixed(2)}" cy="${lastY.toFixed(2)}" r="4" fill="#f3d678" stroke="#08080c" stroke-width="1.6"/>
      </svg>`;

    wrap.innerHTML = svg;

    const axis = el('div', 'y-axis');
    axis.appendChild(el('span', null, String(Math.round(maxR))));
    axis.appendChild(el('span', null, String(Math.round((maxR + minR) / 2))));
    axis.appendChild(el('span', null, String(Math.round(minR))));
    wrap.appendChild(axis);

    const xaxis = el('div', 'x-axis');
    xaxis.appendChild(el('span', null, formatRelativeTime(points[0].ts)));
    xaxis.appendChild(el('span', null, formatRelativeTime(points[Math.floor(n / 2)].ts)));
    xaxis.appendChild(el('span', null, formatRelativeTime(points[n - 1].ts)));
    wrap.appendChild(xaxis);
  }

  _insightEmpty({ glyph, title, body, cta }) {
    const node = el('div', 'insight-empty');
    const g = el('div', 'glyph', glyph);
    node.appendChild(g);
    node.appendChild(el('h4', null, escapeHtml(title)));
    node.appendChild(el('p', null, escapeHtml(body)));
    if (cta) {
      const a = el('a', 'btn btn-primary btn-sm', escapeHtml(cta.label));
      a.href = cta.href;
      node.appendChild(a);
    }
    return node;
  }

  renderOpenings(games) {
    const wrap = document.getElementById('openingsList');
    if (!wrap) return;
    wrap.innerHTML = '';

    const counts = new Map();
    let total = 0;
    for (const g of games) {
      const name = openingName(g);
      if (!name) continue;
      counts.set(name, (counts.get(name) || 0) + 1);
      total += 1;
    }

    if (counts.size === 0) {
      wrap.appendChild(this._insightEmpty({
        glyph: SPARKLE_IC,
        title: 'Openings will appear here',
        body: 'After a few games, your most-played openings will be ranked by frequency.',
      }));
      return;
    }

    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const max = sorted[0][1];

    sorted.forEach(([name, count]) => {
      const pct = total > 0 ? (count / total) * 100 : 0;
      const widthPct = max > 0 ? (count / max) * 100 : 0;
      const row = el('div', 'opening-row');
      row.appendChild(el('span', 'name', escapeHtml(name)));
      const bar = el('div', 'bar');
      bar.appendChild(el('div', 'bar-fill'));
      bar.firstChild.style.width = '0%';
      row.appendChild(bar);
      row.appendChild(el('span', 'count', `${pct.toFixed(0)}%`));
      wrap.appendChild(row);
      requestAnimationFrame(() => { bar.firstChild.style.width = `${widthPct}%`; });
    });
  }

  drawTcChart(games) {
    const wrap = document.getElementById('tcChart');
    if (!wrap) return;
    wrap.innerHTML = '';

    const counts = new Map();
    let total = 0;
    for (const g of games) {
      const tc = timeControl(g);
      if (!tc) continue;
      counts.set(tc, (counts.get(tc) || 0) + 1);
      total += 1;
    }

    if (counts.size === 0) {
      wrap.appendChild(this._insightEmpty({
        glyph: SPARKLE_IC,
        title: 'Time controls will appear here',
        body: 'Your distribution across bullet, blitz, and rapid will show as a donut.',
      }));
      return;
    }

    const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const segments = entries.map(([tc, count], i) => ({ tc, count, pct: total > 0 ? count / total : 0, color: this._donutColor(i) }));

    const size = 200;
    const cx = size / 2, cy = size / 2;
    const rOuter = 86, rInner = 54;

    let angle = -Math.PI / 2;
    const paths = [];
    segments.forEach((s) => {
      const sweep = s.pct * Math.PI * 2;
      const start = angle;
      const end = angle + sweep;
      angle = end;
      paths.push(this._donutPath(cx, cy, rOuter, rInner, start, end, s.color));
    });

    const svg = `
      <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Time control distribution, ${total} games across ${segments.length} controls">
        ${paths.join('')}
        <text x="${cx}" y="${cy - 4}" text-anchor="middle" fill="#f4f1ea" font-family="JetBrains Mono, monospace" font-size="22" font-weight="700">${total}</text>
        <text x="${cx}" y="${cy + 16}" text-anchor="middle" fill="#7a756f" font-family="JetBrains Mono, monospace" font-size="9" letter-spacing="2">GAMES</text>
      </svg>`;

    wrap.innerHTML = svg;

    const legend = el('div', '', '');
    legend.style.cssText = 'display:grid;grid-template-columns:repeat(2,1fr);gap:6px 14px;margin-top:8px;font-family:var(--mono);font-size:11.5px;color:var(--ink-2);';
    segments.forEach((s) => {
      const item = el('div', '', `<span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${s.color};margin-right:7px;"></span>${escapeHtml(s.tc)} <span style="color:var(--ink-3);">· ${Math.round(s.pct * 100)}%</span>`);
      legend.appendChild(item);
    });
    wrap.appendChild(legend);
  }

  _donutColor(i) {
    const palette = ['#d4af37', '#f3d678', '#a07d1d', '#7ac35f', '#5ab0ff', '#b06ff5', '#e05656'];
    return palette[i % palette.length];
  }

  _donutPath(cx, cy, rO, rI, start, end, color) {
    const largeArc = end - start > Math.PI ? 1 : 0;
    const x1 = cx + rO * Math.cos(start);
    const y1 = cy + rO * Math.sin(start);
    const x2 = cx + rO * Math.cos(end);
    const y2 = cy + rO * Math.sin(end);
    const x3 = cx + rI * Math.cos(end);
    const y3 = cy + rI * Math.sin(end);
    const x4 = cx + rI * Math.cos(start);
    const y4 = cy + rI * Math.sin(start);
    return `<path d="M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${rO} ${rO} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} L ${x3.toFixed(2)} ${y3.toFixed(2)} A ${rI} ${rI} 0 ${largeArc} 0 ${x4.toFixed(2)} ${y4.toFixed(2)} Z" fill="${color}" stroke="#08080c" stroke-width="1.5"/>`;
  }

  renderMistakes() {
    const wrap = document.getElementById('mistakesList');
    if (!wrap) return;
    wrap.innerHTML = '';
    wrap.appendChild(el('div', 'mistakes-placeholder', `
      <div class="glyph" aria-hidden="true">${KNIGHT_IC}</div>
      <h4>Coming soon</h4>
      <p>Position-level blunder clusters will appear here once the analysis engine lands.</p>
    `));
  }

  setupProfileActions() {
    const changeBtn = document.getElementById('changeHandle');
    if (changeBtn) {
      changeBtn.addEventListener('click', () => this.openChangeHandle());
    }
    const resetBtn = document.getElementById('resetProfile');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => this.confirmReset());
    }
  }

  async openChangeHandle() {
    const current = (this.user && this.user.handle) || '';
    const field = el('div', 'field');
    field.appendChild(el('label', null, 'New handle'));
    const input = document.createElement('input');
    input.type = 'text';
    input.value = current;
    input.maxLength = 32;
    input.spellcheck = false;
    input.placeholder = 'Your display name';
    field.appendChild(input);

    const hint = el('p', null, 'Visible on your profile, the play panel, and the leaderboard.');
    hint.style.cssText = 'margin:4px 0 0;font-size:12.5px;color:var(--ink-3);font-family:var(--mono);';

    const body = el('div');
    body.appendChild(field);
    body.appendChild(hint);

    const result = await modal({
      title: 'Edit handle',
      body,
      actions: [
        { label: 'Cancel', value: null, kind: 'ghost' },
        { label: 'Save', value: 'save', kind: 'primary' },
      ],
    });

    if (result !== 'save') return;

    const next = input.value.trim();
    if (!next) {
      toast({ title: 'Handle required', message: 'Pick a non-empty name.', kind: 'bad' });
      return;
    }
    if (next === current) {
      toast({ title: 'No change', message: 'That is already your handle.', kind: 'info' });
      return;
    }

    try {
      this.user = store.setHandle(next) || { ...this.user, handle: next };
    } catch (e) {
      this.user = { ...this.user, handle: next };
    }
    setText('handle', this.user.handle);
    toast({
      title: 'Handle updated',
      message: `You are now ${this.user.handle}. Visible on all pages.`,
      kind: 'good',
    });

    if (this.tabsLoaded.leaderboard) {
      this.loadLeaderboard();
    }
  }

  async confirmReset() {
    if (this._resetConfirming) return;
    this._resetConfirming = true;

    const ok = await confirm({
      title: 'Reset profile?',
      message: 'This permanently deletes your handle, rating, and game history on this device. This cannot be undone.',
      confirmLabel: 'Delete everything',
      cancelLabel: 'Keep my data',
      danger: true,
    });

    this._resetConfirming = false;
    if (!ok) return;

    try {
      store.clearAll();
      if (typeof store.clearSyncMeta === 'function') store.clearSyncMeta();
    } catch (e) {}
    toast({ title: 'Profile reset', message: 'Reloading…', kind: 'good' });
    setTimeout(() => { try { location.reload(); } catch (e) {} }, 700);
  }
}

const page = new AccountPage();
page.init().catch((err) => {
  console.error('[account] init failed', err);
  toast({
    title: 'Profile failed to load',
    message: (err && err.message) || 'Unknown error',
    kind: 'bad',
    duration: 8000,
  });
});
