import { store } from './play/store.js';
import {
  toast, modal, confirm, formatRating, formatRelativeTime, formatAccuracy, pieceSvg,
} from './ui.js';

const KEY_USER = 'chessright:user';
const FALLBACK_OPENINGS = ['Italian Game', 'Sicilian Defense', 'French Defense', "Queen's Gambit", 'Ruy Lopez'];
const FALLBACK_TCS = ['1+0', '3+2', '5+0', '10+0', '15+10'];

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

function persistUserHandle(user, newHandle) {
  const trimmed = String(newHandle || '').trim().slice(0, 32);
  if (!trimmed) return user;
  try {
    const merged = { ...user, handle: trimmed, updatedAt: Date.now() };
    localStorage.setItem(KEY_USER, JSON.stringify(merged));
    return merged;
  } catch (e) {
    return user;
  }
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
    this.tabsLoaded = { games: false, leaderboard: false, insights: false };
    this._resetConfirming = false;
  }

  async init() {
    this.bindNav();
    this.bindYear();

    try {
      this.user = store.ensureUser();
    } catch (e) {
      this.user = store.ensureUser();
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
    this.tabsLoaded.games = true;

    await this.renderGames();

    setTimeout(() => this.positionTabUnderline(), 0);
    setTimeout(() => this.positionTabUnderline(), 200);
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
    const avatar = document.getElementById('avatar');
    if (avatar) {
      avatar.innerHTML = pieceSvg('w', 'q');
    }
    setText('handle', user && user.handle ? user.handle : 'Anonymous');
    setText('memberSince', formatMemberSince(user && user.createdAt));

    const rating = user && typeof user.rating === 'number' ? user.rating : 1200;
    const rd = user && (user.ratingVolatility != null ? user.ratingVolatility : user.ratingRd);
    setText('ratingNum', String(Math.round(rating)));
    const rdNode = document.getElementById('ratingRd');
    if (rdNode) {
      rdNode.textContent = rd != null ? `± ${Math.round(rd)} RD` : '';
    }
  }

  renderStats(stats) {
    const s = stats || {};
    setText('statGames', s.gamesPlayed != null ? s.gamesPlayed : 0);
    setText('statWins', s.wins != null ? s.wins : 0);
    setText('statLosses', s.losses != null ? s.losses : 0);
    setText('statDraws', s.draws != null ? s.draws : 0);
    setText('statAcc', this.formatAvgAccuracy(s));
    setText('statStreak', this.formatStreak(s));
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

  async renderGames(filter) {
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

    list.innerHTML = '';

    if (games.length === 0) {
      list.appendChild(el('div', 'empty games-empty', `
        <h3>No games yet</h3>
        <p>Play a game to start building your history.</p>
      `));
      return;
    }

    for (const g of games) {
      list.appendChild(this.renderGameRow(g));
    }
  }

  _renderSkeletons(container, count) {
    container.innerHTML = '';
    for (let i = 0; i < count; i++) {
      container.appendChild(el('div', 'skeleton skel-row', ''));
    }
  }

  renderGameRow(game) {
    const row = el('div', 'game-row');
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.dataset.id = game.id || '';

    const result = game.result || 'draw';
    const badge = el('div', `result-badge ${result}`, resultChar(result));

    const main = el('div', 'game-main');
    const oppWrap = el('div', 'game-opp');
    oppWrap.appendChild(el('span', 'opp-name', escapeHtml(game.opponentName || 'Unknown')));
    if (game.opponentRating != null) {
      oppWrap.appendChild(el('span', 'opp-rating', escapeHtml(String(Math.round(game.opponentRating)))));
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
    sub.appendChild(el('span', null, `${moveCount(game)} moves`));
    const tc = timeControl(game);
    if (tc) {
      sub.appendChild(el('span', 'dot', '·'));
      sub.appendChild(el('span', null, escapeHtml(tc)));
    }
    main.appendChild(sub);

    const accStat = el('div', 'game-stat');
    accStat.appendChild(el('span', `stat-v acc ${accuracyClass(game.accuracy)}`, formatAccuracy(game.accuracy)));
    accStat.appendChild(el('span', 'stat-k', 'accuracy'));
    const durStat = el('div', 'game-stat');
    durStat.appendChild(el('span', 'stat-v', formatDuration(game.durationMs)));
    durStat.appendChild(el('span', 'stat-k', 'duration'));
    const dateStat = el('div', 'game-stat date');
    const ts = game.endedAt != null ? game.endedAt : game.startedAt;
    dateStat.appendChild(el('span', 'stat-v', formatRelativeTime(ts)));
    dateStat.appendChild(el('span', 'stat-k', 'played'));

    const view = el('div', 'game-view', 'View →');

    row.appendChild(badge);
    row.appendChild(main);
    row.appendChild(accStat);
    row.appendChild(durStat);
    row.appendChild(dateStat);
    row.appendChild(view);

    const open = () => this.openGameModal(game);
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });

    return row;
  }

  async openGameModal(game) {
    const body = document.createElement('div');
    const meta = document.createElement('p');
    const opp = escapeHtml(game.opponentName || 'Unknown');
    const you = this.user && this.user.handle ? escapeHtml(this.user.handle) : 'You';
    const white = game.color === 'b' ? opp : you;
    const black = game.color === 'b' ? you : opp;
    meta.innerHTML = `<strong>${white}</strong> (White) vs <strong>${black}</strong> (Black) — result: ${escapeHtml((game.result || 'draw').toUpperCase())}`;
    body.appendChild(meta);

    const detailLines = [];
    if (openingName(game)) detailLines.push(`Opening: ${openingName(game)}`);
    detailLines.push(`Moves: ${moveCount(game)}`);
    if (game.accuracy != null) detailLines.push(`Accuracy: ${formatAccuracy(game.accuracy)}`);
    if (game.durationMs != null) detailLines.push(`Duration: ${formatDuration(game.durationMs)}`);
    if (timeControl(game)) detailLines.push(`Time control: ${timeControl(game)}`);
    if (detailLines.length) {
      const d = document.createElement('p');
      d.textContent = detailLines.join(' · ');
      body.appendChild(d);
    }

    const pgn = game.pgn || '(no PGN stored for this game)';
    body.appendChild(el('pre', null, pgn));

    const result = await modal({
      title: 'Game replay',
      body,
      wide: true,
      actions: [
        { label: 'Close', value: 'close', kind: 'ghost' },
        { label: 'Load in board', value: 'board', kind: 'primary' },
      ],
    });

    if (result === 'board') {
      toast({
        title: 'Board load coming soon',
        message: 'PGN replay will open in the play view once it ships.',
        kind: 'info',
      });
    }
  }

  setupGamesToolbar() {
    const filter = document.getElementById('filterResult');
    if (filter) {
      filter.addEventListener('change', () => {
        this.filter = filter.value;
        this.renderGames(this.filter);
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

  async loadLeaderboard() {
    const target = document.getElementById('leaderboard');
    if (!target) return;
    target.innerHTML = '';

    const rows = this._localLeaderboard();
    this.renderLeaderboard(target, rows, 'local');
  }

  _localLeaderboard() {
    const me = {
      rank: 1, handle: (this.user && this.user.handle) || 'You',
      rating: Math.round((this.user && this.user.rating) || 1200),
      games: this.stats && this.stats.gamesPlayed || 0,
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

  _lbSkelRow() {
    const row = el('div', 'lb-row');
    row.appendChild(el('div', 'lb-rank skeleton', ''));
    row.appendChild(el('div', 'lb-handle skeleton', ''));
    row.appendChild(el('div', 'lb-rating skeleton', ''));
    row.appendChild(el('div', 'lb-games skeleton', ''));
    for (const c of [row.querySelector('.lb-rank'), row.querySelector('.lb-handle'), row.querySelector('.lb-rating'), row.querySelector('.lb-games')]) {
      if (c) { c.style.height = '14px'; c.style.width = c.classList.contains('lb-handle') ? '70%' : '40px'; }
    }
    return row;
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

    rows.slice(0, 100).forEach((r) => {
      const row = el('div', `lb-row${r.isMe ? ' me' : ''}`);
      row.appendChild(el('span', `lb-rank${r.rank <= 3 ? ' top' : ''}`, `#${r.rank}`));
      const handleCell = el('span', 'lb-handle');
      handleCell.textContent = r.handle || 'Anonymous';
      if (r.isMe) {
        const tag = el('span', 'me-tag', 'you');
        handleCell.appendChild(tag);
      }
      row.appendChild(handleCell);
      row.appendChild(el('span', 'lb-rating', String(r.rating)));
      row.appendChild(el('span', 'lb-games', String(r.games || 0)));
      target.appendChild(row);
    });

    if (source === 'local') {
      const note = el('div', 'lb-note');
      note.textContent = 'Showing opponents you have played. Play more games to fill out your circle.';
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
      wrap.appendChild(el('div', 'empty-mini', 'Not enough games yet.'));
      return;
    }

    if (points.length === 1) {
      points.unshift({ ts: points[0].ts - 1000, rating: baseRating });
    }

    const W = 400, H = 100, padX = 6, padY = 14;
    const ratings = points.map((p) => p.rating);
    let minR = Math.min(...ratings);
    let maxR = Math.max(...ratings);
    if (minR === maxR) { minR -= 25; maxR += 25; }
    const span = Math.max(1, maxR - minR);
    const pad = span * 0.08;
    minR -= pad; maxR += pad;

    const n = points.length;
    const xAt = (i) => n <= 1 ? padX : padX + (i / (n - 1)) * (W - padX * 2);
    const yAt = (r) => H - padY - ((r - minR) / (maxR - minR)) * (H - padY * 2);

    const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i).toFixed(2)} ${yAt(p.rating).toFixed(2)}`).join(' ');
    const fillPath = `${linePath} L ${xAt(n - 1).toFixed(2)} ${H - padY} L ${xAt(0).toFixed(2)} ${H - padY} Z`;

    const last = points[points.length - 1].rating;
    const lastX = xAt(n - 1);
    const lastY = yAt(last);

    const grad = `cr-rate-${Math.random().toString(36).slice(2, 8)}`;
    const svg = `
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Rating over time">
        <defs>
          <linearGradient id="${grad}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#d4af37" stop-opacity="0.45"/>
            <stop offset="100%" stop-color="#d4af37" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <path d="${fillPath}" fill="url(#${grad})" stroke="none"/>
        <path d="${linePath}" fill="none" stroke="#f3d678" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
        <circle cx="${lastX.toFixed(2)}" cy="${lastY.toFixed(2)}" r="3.2" fill="#f3d678" stroke="#08080c" stroke-width="1.4"/>
      </svg>`;

    wrap.innerHTML = svg;
    const axis = el('div', 'y-axis');
    axis.appendChild(el('span', null, String(Math.round(maxR))));
    axis.appendChild(el('span', null, String(Math.round((maxR + minR) / 2))));
    axis.appendChild(el('span', null, String(Math.round(minR))));
    wrap.appendChild(axis);
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
      wrap.appendChild(el('div', 'empty-mini', 'Opening data appears after a few games.'));
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
      wrap.appendChild(el('div', 'empty-mini', 'Play a few games to see your time control mix.'));
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
      <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-label="Time control distribution">
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
      <div class="glyph" aria-hidden="true">♞</div>
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

    const result = await modal({
      title: 'Change handle',
      body: field,
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

    this.user = persistUserHandle(this.user, next);
    setText('handle', this.user.handle);
    toast({ title: 'Handle updated', message: `You are now ${this.user.handle}.`, kind: 'good' });
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

    try { store.clearAll(); } catch (e) {}
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
