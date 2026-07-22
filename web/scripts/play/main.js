import { Chess } from 'https://esm.sh/chess.js@1.0.0?bundle';
import { Board } from './board.js';
import { Engine } from './engine.js';
import { store } from './store.js';
import { analyzeGame, accuracyToElo } from './accuracy.js';
import { Clock } from './clock.js';
import { InviteHost, InviteGuest, parseInviteFromUrl } from './net.js';
import { GameSocket } from './ws.js';
import { toast, confirm, formatTime } from '../ui.js';

const API_BASE_URL = (() => {
  try {
    const meta = document.querySelector('meta[name="x-api-base"]');
    if (meta && meta.content) return meta.content.replace(/\/+$/, '');
  } catch (_) {}
  return 'https://chessright-api.agntlol.workers.dev';
})();

const MATCH_POLL_INTERVAL_MS = 1500;
const MATCH_POLL_TIMEOUT_MS = 120000;
const SERVER_HEALTH_TIMEOUT_MS = 5000;

const GLYPH = { p: '\u265F', n: '\u265E', b: '\u265D', r: '\u265C', q: '\u265B', k: '\u265A' };

const SKILL_TO_ELO = (s) => {
  const t = Math.max(0, Math.min(20, s)) / 20;
  return Math.round(800 + (2400 - 800) * t);
};

const BOT_NAMES = [
  'Rookie Riley', 'Beginner Bo', 'Casual Cara', 'Friendly Frank',
  'Club Player Kai', 'Steady Sam', 'Tournament Tina', 'Sharp Shooter',
  'Tactical Tom', 'Strong Player', 'Expert Ellis', 'Master Morgan',
  'Grandmaster G', 'Wizard of Chess', 'The Professor', 'Iron Knight',
  'Steel Bishop', 'Golden Rook', 'Phantom Queen', 'Immortal King',
];

function botName(level) {
  const idx = Math.max(0, Math.min(BOT_NAMES.length - 1, level - 1));
  return BOT_NAMES[idx];
}

const SKILL_LABELS = [
  [1, 2, 'Just learning the rules'],
  [3, 4, 'Casual player'],
  [5, 6, 'Club player'],
  [7, 8, 'Tournament player'],
  [9, 10, 'Strong tournament'],
  [11, 12, 'Expert'],
  [13, 20, 'Master and above'],
];

function skillLabel(level) {
  for (const [min, max, label] of SKILL_LABELS) {
    if (level >= min && level <= max) return label;
  }
  return 'Custom';
}

const TIME_CONTROLS = {
  bullet:     { label: 'Bullet',     base: 60,   incr: 0,    display: '1+0'   },
  blitz:      { label: 'Blitz',      base: 300,  incr: 3,    display: '5+3'   },
  rapid:      { label: 'Rapid',      base: 600,  incr: 5,    display: '10+5'  },
  classical:  { label: 'Classical',  base: 1800, incr: 0,    display: '30+0'  },
};

const RESULT_ICONS = {
  win: '\u{1F3C6}',
  loss: '\u2620',
  draw: '\u{1F91D}',
};

function $(id) { return document.getElementById(id); }
function show(el) { if (el) el.hidden = false; }
function hide(el) { if (el) el.hidden = true; }

class GameController {
  constructor() {
    this.chess = new Chess();
    this.board = null;
    this.engine = null;
    this.clock = null;
    this.mode = null;
    this.myColor = 'w';
    this.botColor = 'b';
    this.opponent = null;
    this.moveHistory = [];
    this.evalHistory = [];
    this.reviewIndex = -1;
    this.busy = false;
    this.ended = false;
    this.skillLevel = 8;
    this.timeControl = TIME_CONTROLS.rapid;
    this.user = null;
    this.peer = null;
    this.socket = null;
    this.gameId = null;
    this.drawOffered = null;
    this.serverOnline = false;
    this._matchTicketAbort = null;
    this._serverRatingDelta = null;
  }

  async init() {
    try {
      this.user = store.ensureUser();
    } catch (e) {
      this.user = { handle: 'Guest', rating: 1200 };
    }

    const nav = $('nav');
    if (nav) {
      const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 24);
      window.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
    }

    this._wireLobby();
    this._wireGameControls();
    this._wirePostGame();
    this._refreshMePanel();

    this._checkServerHealth();

    const joinCode = parseInviteFromUrl();
    if (joinCode) {
      const friendCard = document.querySelector('[data-mode="friend"]');
      if (friendCard) friendCard.click();
      const inp = $('friendCode');
      if (inp) inp.value = joinCode.replace(/^CR-/, '');
    }
  }

  _wireLobby() {
    const cards = document.querySelectorAll('.mode-card');
    cards.forEach((card) => {
      card.addEventListener('click', () => {
        if (card.classList.contains('disabled') || card.disabled) {
          toast({ title: 'Server offline', message: 'Matchmaking is unavailable right now. Try the engine or a friend.', kind: 'bad' });
          return;
        }
        cards.forEach((c) => c.classList.remove('selected'));
        card.classList.add('selected');
        this._renderConfig(card.dataset.mode);
      });
    });
  }

  _renderConfig(mode) {
    const panel = $('configPanel');
    if (!panel) return;
    this.mode = mode;
    panel.hidden = false;

    if (mode === 'bot') {
      panel.innerHTML = this._botConfigHtml();
      this._wireBotConfig();
    } else if (mode === 'friend') {
      panel.innerHTML = this._friendConfigHtml();
      this._wireFriendConfig();
    } else if (mode === 'match') {
      panel.innerHTML = this._matchConfigHtml();
      this._wireMatchConfig();
    }
  }

  _botConfigHtml() {
    return `
      <div class="cfg-head">
        <span class="cfg-title">Configure the engine</span>
        <span class="cfg-sub">Stockfish WASM</span>
      </div>
      <div class="cfg-row">
        <label class="cfg-label">Skill level</label>
        <div class="difficulty-row">
          <input type="range" id="skillSlider" min="1" max="20" value="${this.skillLevel}" />
          <span class="difficulty-elo" id="skillElo">${SKILL_TO_ELO(this.skillLevel)} Elo</span>
        </div>
        <div class="difficulty-labels">
          <span>Beginner</span><span>Club</span><span>Master</span><span>GM</span>
        </div>
        <div class="skill-label" id="skillLabel">${skillLabel(this.skillLevel)}</div>
      </div>
      <div class="cfg-row">
        <label class="cfg-label">Time control</label>
        <div class="tc-grid" id="tcGrid">${this._tcButtonsHtml('rapid')}</div>
      </div>
      <div class="cfg-foot">
        <button class="btn btn-primary" id="startGameBtn">Start game</button>
      </div>
    `;
  }

  _friendConfigHtml() {
    return `
      <div class="cfg-head">
        <span class="cfg-title">Play a friend</span>
        <span class="cfg-sub">Peer-to-peer invite</span>
      </div>
      <div class="friend-config">
        <div class="friend-option">
          <h4>Create a game</h4>
          <p>Get a code to share with your friend</p>
          <button class="btn btn-primary" id="createInviteBtn">Create game</button>
        </div>
        <div class="friend-option">
          <h4>Join a game</h4>
          <p>Enter your friend's code</p>
          <input type="text" class="code-input" id="friendCode" maxlength="6"
                 placeholder="ABC123" autocomplete="off" spellcheck="false" />
          <button class="btn btn-ghost" id="joinGameBtn">Join</button>
        </div>
      </div>
      <p class="friend-note">Playing a friend is the best way to learn. Share your link and start a game in seconds.</p>
    `;
  }

  _matchConfigHtml() {
    const rating = Math.round((this.user && this.user.rating) || 1200);
    return `
      <div class="cfg-head">
        <span class="cfg-title">Find a match</span>
        <span class="cfg-sub">Ranked \u00b7 server-relay \u00b7 rating ${rating}</span>
      </div>
      <div class="cfg-row">
        <label class="cfg-label">Time control</label>
        <div class="tc-grid" id="tcGrid">${this._tcButtonsHtml('rapid')}</div>
      </div>
      <div class="cfg-foot">
        <button class="btn btn-primary" id="searchMatchBtn">Search for a game</button>
      </div>
    `;
  }

  _wireMatchConfig() {
    this._wireTcGrid();
    const search = $('searchMatchBtn');
    if (search) search.addEventListener('click', () => this.startMatchedGame(this.timeControl));
  }

  _tcButtonsHtml(selectedKey) {
    this.timeControl = TIME_CONTROLS[selectedKey] || TIME_CONTROLS.rapid;
    return Object.entries(TIME_CONTROLS).map(([key, tc]) => `
      <button type="button" class="tc-btn ${key === selectedKey ? 'selected' : ''}" data-tc="${key}">
        <span class="tc-name">${tc.label}</span>
        <span class="tc-time">${tc.display}</span>
      </button>
    `).join('');
  }

  _wireBotConfig() {
    const slider = $('skillSlider');
    const eloEl = $('skillElo');
    const labelEl = $('skillLabel');
    if (slider && eloEl) {
      const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      slider.addEventListener('input', () => {
        this.skillLevel = parseInt(slider.value, 10);
        eloEl.textContent = SKILL_TO_ELO(this.skillLevel) + ' Elo';
        if (labelEl) {
          const next = skillLabel(this.skillLevel);
          const prev = labelEl.textContent;
          if (next !== prev) {
            if (reduce) {
              labelEl.textContent = next;
            } else {
              labelEl.style.transition = 'opacity 0.12s var(--ease)';
              labelEl.style.opacity = '0';
              window.setTimeout(() => {
                labelEl.textContent = next;
                labelEl.style.opacity = '1';
              }, 90);
            }
          }
        }
      });
    }
    this._wireTcGrid();
    const start = $('startGameBtn');
    if (start) start.addEventListener('click', () => this._startFromConfig());
  }

  _wireFriendConfig() {
    const input = $('friendCode');
    if (input) {
      input.addEventListener('input', () => {
        input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this._joinFriendFromConfig();
      });
    }
    const createInvite = $('createInviteBtn');
    if (createInvite) createInvite.addEventListener('click', () => this.startFriendHost());
    const join = $('joinGameBtn');
    if (join) join.addEventListener('click', () => this._joinFriendFromConfig());
  }

  _joinFriendFromConfig() {
    const input = $('friendCode');
    const code = (input && input.value || '').trim();
    if (code.length !== 6) {
      toast({ title: 'Invalid code', message: 'Invite codes are 6 characters.', kind: 'bad' });
      return;
    }
    this.startFriendGame(code);
  }

  _wireTcGrid() {
    const grid = $('tcGrid');
    if (!grid) return;
    grid.querySelectorAll('.tc-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        grid.querySelectorAll('.tc-btn').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
        const key = btn.dataset.tc;
        this.timeControl = TIME_CONTROLS[key] || TIME_CONTROLS.rapid;
      });
    });
  }

  async _startFromConfig() {
    if (this.mode === 'bot') {
      await this.startBotGame(this.skillLevel);
    }
  }

  _showGameScreen() {
    hide($('lobby'));
    hide($('postGame'));
    show($('game'));
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  }

  async startBotGame(skillLevel) {
    this._resetState();
    this.mode = 'bot';
    this.skillLevel = skillLevel;
    this.myColor = Math.random() < 0.5 ? 'w' : 'b';
    this.botColor = this.myColor === 'w' ? 'b' : 'w';

    this.opponent = {
      name: botName(skillLevel),
      rating: SKILL_TO_ELO(skillLevel),
      kind: 'bot',
    };

    this._showGameScreen();
    this._refreshOppPanel();
    this._refreshMePanel();
    this._initBoard();
    this._initClocks();

    try {
      this.engine = new Engine({
        onError: (err) => {
          toast({ title: 'Engine error', message: err.message || 'Stockfish failed', kind: 'bad' });
        },
      });
      await this.engine.ready();
      await this.engine.setLevel(this._skillToLevel(skillLevel));
      await this.engine.newGame();
    } catch (err) {
      toast({ title: 'Engine unavailable', message: 'Falling back to a simple bot.', kind: 'bad' });
      this.engine = null;
    }

    this._startGameFlow();
  }

  _onPeerMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'move': this._applyRemoteMove(msg); break;
      case 'resign': this._onGameEnd('win', 'resignation'); break;
      case 'draw_offer': this._onRemoteDrawOffer(); break;
      case 'draw_decline': this._onDrawDecline(); break;
      case 'clock': if (this.clock) this.clock.onRemoteSync(msg.color, msg.remaining); break;
      case 'goodbye': this._onPeerDisconnect(); break;
    }
  }

  _applyRemoteMove(msg) {
    if (this.ended) return;
    if (this.chess.turn() === this.myColor) return;
    let move;
    try {
      move = this.chess.move({ from: msg.from, to: msg.to, promotion: msg.promotion || 'q' });
    } catch (e) {
      return;
    }
    if (!move) return;

    this.moveHistory.push({
      verbose: move,
      fenBefore: move.before,
      fenAfter: move.after,
      color: move.color,
      ply: this.moveHistory.length,
    });

    this.board.setPosition(this.chess);
    this._highlightLast(move);
    this._renderMoves();
    this._asyncEval();
    this._maybeAdvanceClock(move.color);

    if (this.chess.isGameOver()) {
      this._resolveGameEnd();
      return;
    }
    if (this.chess.turn() === this.myColor &&
        this.board && this.board.premoveQueue.length > 0) {
      this._executePremoves();
    }
  }

  _onRemoteDrawOffer() {
    if (this.ended) return;
    if (this.drawOffered === this.myColor) {
      this._endGame('draw', 'agreement');
      return;
    }
    confirm({
      title: 'Draw offered',
      message: 'Your opponent offers a draw. Accept?',
      confirmLabel: 'Accept',
      cancelLabel: 'Decline',
    }).then((accept) => {
      if (this.ended) return;
      if (this.socket && this.socket.isOpen) {
        if (accept) {
          this.socket.sendDrawAccept();
        } else {
          this.socket.sendDrawDecline();
        }
        return;
      }
      if (!this.peer || !this.peer.isOpen) return;
      if (accept) {
        this.peer.send({ t: 'draw_offer' });
        this._endGame('draw', 'agreement');
      } else {
        this.peer.send({ t: 'draw_decline' });
      }
    });
  }

  _onDrawDecline() {
    this.drawOffered = null;
    toast({ title: 'Draw declined', message: 'Your opponent declined the draw.', kind: 'info' });
  }

  _onPeerDisconnect() {
    if (this.ended) return;
    toast({ title: 'Opponent disconnected', message: 'Game abandoned.', kind: 'bad' });
    this._endGame('win', 'abandoned');
  }

  _onGameEnd(result, ending) {
    if (this.ended) return;
    this._endGame(result, ending);
  }

  async startFriendGame(code) {
    if (!code || typeof code !== 'string') return;
    const user = store.ensureUser();

    this._resetState();
    this.mode = 'friend';
    this.opponent = { kind: 'human', name: 'Opponent', rating: 1200 };

    this._showJoinOverlay('Connecting to host...');

    try {
      this.peer = new InviteGuest({
        handle: user.handle,
        rating: user.rating,
        onMessage: (msg) => this._onPeerMessage(msg),
        onHostConnected: ({ hostHandle, hostRating, myColor }) => {
          this.myColor = myColor;
          this.botColor = myColor === 'w' ? 'b' : 'w';
          this.opponent = { kind: 'human', name: hostHandle || 'Host', rating: hostRating || 1200 };
        },
        onHostDisconnected: () => this._onPeerDisconnect(),
        onError: (err) => this._updateJoinStatus(err.message, 'bad'),
        onStatusChange: (status) => {
          const msgs = {
            connecting: 'Connecting to broker...',
            connected: 'Contacting host...',
            reconnecting: 'Reconnecting...',
            failed: 'Connection failed.',
          };
          this._updateJoinStatus(msgs[status] || status, status === 'failed' ? 'bad' : 'info');
        },
      });
      const result = await this.peer.join(code);
      this.myColor = result.myColor;
      this.botColor = this.myColor === 'w' ? 'b' : 'w';
      this.opponent = { kind: 'human', name: result.hostHandle || 'Host', rating: result.hostRating || 1200 };
      this.gameId = 'invite-' + code;

      this._hideJoinOverlay();
      this._showGameScreen();
      this._refreshOppPanel();
      this._refreshMePanel();
      this._initBoard();
      this._initClocks();
      this._startGameFlow();

      if (window.history && window.history.replaceState) {
        window.history.replaceState(null, '', window.location.pathname);
      }
    } catch (err) {
      if (this.peer) { try { this.peer.leave(); } catch (_) {} this.peer = null; }
      const message =
        (err && err.message) || 'Invalid code or host offline.';
      this._updateJoinStatus(message, 'bad');
      const codeRef = code;
      await this._showJoinErrorModal(message, () => {
        this.startFriendGame(codeRef);
      });
    }
  }

  async startFriendHost() {
    const user = store.ensureUser();
    this._resetState();
    this.mode = 'friend';
    this.opponent = { kind: 'human', name: 'Waiting\u2026', rating: 0 };

    try {
      this.peer = new InviteHost({
        handle: user.handle,
        rating: user.rating,
        onMessage: (msg) => this._onPeerMessage(msg),
        onGuestConnected: ({ guestHandle, guestRating, myColor }) => {
          this.myColor = myColor;
          this.botColor = myColor === 'w' ? 'b' : 'w';
          this.opponent = { kind: 'human', name: guestHandle || 'Guest', rating: guestRating || 1200 };
          this.gameId = 'invite-host';
          this._hideInviteWaiting();
          this._showGameScreen();
          this._refreshOppPanel();
          this._refreshMePanel();
          this._initBoard();
          this._initClocks();
          this._startGameFlow();
        },
        onGuestDisconnected: () => this._onPeerDisconnect(),
        onError: (err) => {
          this._updateInviteStatus('Connection failed: ' + err.message, 'bad');
        },
        onStatusChange: (status) => {
          const msgs = {
            connecting: 'Connecting to broker...',
            connected: 'Connected. Waiting for opponent...',
            reconnecting: 'Connection lost, reconnecting...',
            failed: 'Connection failed. Please try again.',
          };
          this._updateInviteStatus(
            msgs[status] || status,
            status === 'failed' ? 'bad' : 'info'
          );
        },
      });
      this._showInviteWaiting(null, null);
      const { code, shareUrl } = await this.peer.create();
      this._fillInviteCode(code, shareUrl);
    } catch (err) {
      toast({ title: 'Could not create invite', message: err.message, kind: 'bad' });
    }
  }

  async _checkServerHealth() {
    if (!this._supportsFetch()) {
      this._setMatchCardAvailability(false);
      return;
    }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), SERVER_HEALTH_TIMEOUT_MS);
      const res = await fetch(API_BASE_URL + '/api/health', {
        method: 'GET',
        signal: ctrl.signal,
        headers: { Accept: 'application/json' },
      });
      clearTimeout(timer);
      this._setMatchCardAvailability(res.ok);
    } catch (_) {
      this._setMatchCardAvailability(false);
    }
  }

  _supportsFetch() {
    return typeof fetch === 'function' && typeof WebSocket === 'function';
  }

  _setMatchCardAvailability(online) {
    this.serverOnline = !!online;
    const card = document.querySelector('.mode-card[data-mode="match"]');
    if (!card) return;
    if (this.serverOnline) {
      card.classList.remove('disabled');
      card.removeAttribute('aria-disabled');
      card.removeAttribute('title');
    } else {
      card.classList.add('disabled');
      card.setAttribute('aria-disabled', 'true');
      card.setAttribute('title', 'Server offline');
    }
    if (this.mode === 'match' && !this.serverOnline) {
      const panel = $('configPanel');
      if (panel) {
        panel.innerHTML = '<div class="cfg-head"><span class="cfg-title">Server offline</span><span class="cfg-sub">Matchmaking is unavailable</span></div>';
      }
    }
  }

  async startMatchedGame(timeControl) {
    if (!this.serverOnline) {
      toast({ title: 'Server offline', message: 'Matchmaking is unavailable right now.', kind: 'bad' });
      return;
    }

    const user = store.ensureUser();
    const tc = timeControl || this.timeControl || TIME_CONTROLS.rapid;
    const tcKey = Object.keys(TIME_CONTROLS).find((k) => TIME_CONTROLS[k] === tc) || 'rapid';

    this._resetState();
    this.mode = 'match';
    this.timeControl = tc;
    this.opponent = { kind: 'human', name: 'Searching\u2026', rating: 0 };

    this._showMatchOverlay('Searching for an opponent\u2026');

    const ctrl = new AbortController();
    this._matchTicketAbort = ctrl;

    let ticket;
    try {
      ticket = await this._matchQueue(user, tcKey, ctrl.signal);
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      this._hideMatchOverlay();
      toast({ title: 'Could not queue', message: (err && err.message) || 'Matchmaking failed.', kind: 'bad' });
      return;
    }

    if (ctrl.signal.aborted) return;

    this._updateMatchStatus('Opponent found. Connecting\u2026');

    let match;
    try {
      match = await this._matchPoll(ticket.ticketId, ctrl.signal);
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      this._hideMatchOverlay();
      toast({ title: 'Matchmaking failed', message: (err && err.message) || 'No opponent found.', kind: 'bad' });
      return;
    }

    if (ctrl.signal.aborted) return;

    this.myColor = match.myColor === 'b' ? 'b' : 'w';
    this.botColor = this.myColor === 'w' ? 'b' : 'w';
    this.opponent = {
      kind: 'human',
      name: (match.opponent && match.opponent.handle) || 'Opponent',
      rating: (match.opponent && match.opponent.rating) || 1200,
    };
    this.gameId = match.gameId;

    const serverUrl = match.serverUrl || API_BASE_URL;

    this.socket = new GameSocket({
      serverUrl,
      gameId: match.gameId,
      token: user.token,
      userId: user.id,
      onMove: (mv) => this._onSocketMove(mv),
      onClock: (clock) => this._onSocketClock(clock),
      onGameOver: (result) => this._onSocketGameOver(result),
      onDrawOffer: () => this._onRemoteDrawOffer(),
      onPrank: (prankType) => this._onPrank(prankType),
      onDisconnect: (info) => this._onSocketOpponentDisconnect(info),
      onReconnect: () => this._onSocketOpponentReconnect(),
      onStatus: (status) => this._onSocketStatus(status),
      onError: (err) => toast({ title: 'Connection issue', message: err.message, kind: 'bad' }),
    });

    try {
      await this.socket.connect();
    } catch (err) {
      this._hideMatchOverlay();
      toast({ title: 'Connection failed', message: (err && err.message) || 'Could not reach the game server.', kind: 'bad' });
      return;
    }

    this._hideMatchOverlay();
    this._showGameScreen();
    this._refreshOppPanel();
    this._refreshMePanel();
    this._initBoard();
    this._initClocks();
    this._startGameFlow();
  }

  async _matchQueue(user, tcKey, signal) {
    const res = await fetch(API_BASE_URL + '/api/match/queue', {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        rating: Math.round(user.rating || 1200),
        timeControl: tcKey,
        peerId: user.id,
        handle: user.handle,
      }),
    });
    if (!res.ok) {
      const txt = await this._safeReadError(res);
      throw new Error(txt || ('Queue rejected (' + res.status + ')'));
    }
    return res.json();
  }

  async _matchPoll(ticketId, signal) {
    const url = API_BASE_URL + '/api/match/poll/' + encodeURIComponent(ticketId);
    const deadline = Date.now() + MATCH_POLL_TIMEOUT_MS;
    let firstDelay = 300;
    while (Date.now() < deadline) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      await new Promise((r) => setTimeout(r, firstDelay));
      firstDelay = MATCH_POLL_INTERVAL_MS;
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      let res;
      try {
        res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        continue;
      }
      if (res.status === 202) {
        this._updateMatchStatus('Still searching\u2026');
        continue;
      }
      if (res.ok) {
        return res.json();
      }
      if (res.status === 404 || res.status === 410) {
        const txt = await this._safeReadError(res);
        throw new Error(txt || 'Matchmaking ticket expired.');
      }
      const txt = await this._safeReadError(res);
      throw new Error(txt || ('Poll failed (' + res.status + ')'));
    }
    throw new Error('Timed out searching for an opponent.');
  }

  async _safeReadError(res) {
    try {
      const data = await res.json();
      return (data && (data.error || data.message)) || null;
    } catch (_) {
      try { return await res.text(); } catch (_) { return null; }
    }
  }

  _onSocketMove(mv) {
    if (!mv) return;
    if (mv.rejected) {
      toast({ title: 'Move rejected', message: mv.reason || 'The server rejected that move.', kind: 'bad' });
      return;
    }
    if (mv.resume) {
      return;
    }
    this._applyRemoteMove({ from: mv.from, to: mv.to, promotion: mv.promotion });
  }

  _onSocketClock(clock) {
    if (!clock || !this.clock) return;
    const w = typeof clock.w === 'number' ? clock.w : null;
    const b = typeof clock.b === 'number' ? clock.b : null;
    if (w != null) this.clock.remaining.w = Math.max(0, w);
    if (b != null) this.clock.remaining.b = Math.max(0, b);
    if (w != null) this._updateClockDisplay('w', w / 1000);
    if (b != null) this._updateClockDisplay('b', b / 1000);
  }

  _onSocketGameOver(result) {
    if (this.ended) return;
    const r = (result && result.result) || 'draw';
    const ending = (result && result.ending) || 'unknown';
    if (result && result.ratingDelta != null) {
      this._serverRatingDelta = result.ratingDelta;
    }
    this._endGame(r, ending);
  }

  _onSocketOpponentDisconnect(info) {
    if (this.ended) return;
    const secs = info && typeof info.reconnectIn === 'number'
      ? Math.max(0, Math.round(info.reconnectIn / 1000))
      : null;
    if (info && info.permanent) {
      toast({ title: 'Opponent left', message: 'Game abandoned.', kind: 'bad' });
      this._endGame('win', 'abandoned');
      return;
    }
    toast({
      title: 'Opponent disconnected',
      message: secs != null ? 'Reconnecting\u2026 (' + secs + 's)' : 'Waiting for opponent to reconnect.',
      kind: 'info',
    });
    if (this.clock) this.clock.stop();
  }

  _onSocketOpponentReconnect() {
    if (this.ended) return;
    toast({ title: 'Opponent reconnected', message: 'The game resumes.', kind: 'good' });
    if (this.clock && !this.ended) {
      this.clock.userStopped = false;
      try { this.clock._startTimer(); } catch (_) {}
    }
  }

  _onSocketStatus(status) {
    if (status === 'reconnecting') {
      toast({ title: 'Reconnecting', message: 'Restoring the connection\u2026', kind: 'info' });
    } else if (status === 'error') {
      toast({ title: 'Connection lost', message: 'Could not restore the game session.', kind: 'bad' });
    }
  }

  _onPrank(prankType) {
    if (!prankType) return;
    toast({ title: 'Prank!', message: 'A mysterious force interferes: ' + prankType, kind: 'info' });
  }

  _showMatchOverlay(message) {
    let overlay = $('matchOverlay');
    if (!overlay) {
      overlay = document.createElement('section');
      overlay.id = 'matchOverlay';
      overlay.className = 'invite-waiting';
      const main = document.querySelector('.play-page') || document.body;
      main.appendChild(overlay);
    }
    overlay.innerHTML = `
      <div class="invite-card">
        <h2>Finding a match</h2>
        <div class="invite-status info" id="matchStatus">${message || 'Searching\u2026'}</div>
        <div class="invite-actions">
          <button type="button" class="btn btn-ghost" id="cancelMatchBtn">Cancel</button>
        </div>
        <div class="spinner-wrap"><div class="spinner"></div></div>
      </div>
    `;
    overlay.removeAttribute('hidden');
    const lobby = $('lobby');
    if (lobby) lobby.setAttribute('hidden', '');
    const game = $('game');
    if (game) game.setAttribute('hidden', '');
    const cancel = $('cancelMatchBtn');
    if (cancel) cancel.addEventListener('click', () => this._cancelMatchmaking());
  }

  _updateMatchStatus(text, kind = 'info') {
    const el = $('matchStatus');
    if (!el) return;
    el.textContent = text;
    el.className = 'invite-status ' + kind;
  }

  _hideMatchOverlay() {
    const overlay = $('matchOverlay');
    if (overlay) overlay.setAttribute('hidden', '');
  }

  _cancelMatchmaking() {
    if (this._matchTicketAbort) {
      try { this._matchTicketAbort.abort(); } catch (_) {}
      this._matchTicketAbort = null;
    }
    if (this.socket) { try { this.socket.close(); } catch (_) {} this.socket = null; }
    this._hideMatchOverlay();
    this._resetState();
    const lob = $('lobby');
    if (lob) lob.removeAttribute('hidden');
  }

  _fillInviteCode(code, shareUrl) {
    const codeEl = document.querySelector('.invite-code');
    if (codeEl && code) {
      codeEl.textContent = code;
      codeEl.classList.remove('placeholder');
    }
    const copyCodeBtn = $('copyCodeBtn');
    if (copyCodeBtn && code) {
      copyCodeBtn.disabled = false;
      copyCodeBtn.onclick = () => {
        navigator.clipboard.writeText(code).then(() => toast({ title: 'Copied', message: 'Invite code copied', kind: 'good' }));
      };
    }
    const copyLinkBtn = $('copyLinkBtn');
    if (copyLinkBtn && shareUrl) {
      copyLinkBtn.disabled = false;
      copyLinkBtn.onclick = () => {
        navigator.clipboard.writeText(shareUrl).then(() => toast({ title: 'Copied', message: 'Invite link copied', kind: 'good' }));
      };
    }
  }

  _showInviteWaiting(code, shareUrl) {
    const lobby = $('lobby');
    if (lobby) lobby.setAttribute('hidden', '');
    const game = $('game');
    if (game) game.setAttribute('hidden', '');
    const postGame = $('postGame');
    if (postGame) postGame.setAttribute('hidden', '');

    let wait = $('inviteWaiting');
    if (!wait) {
      wait = document.createElement('section');
      wait.id = 'inviteWaiting';
      wait.className = 'invite-waiting';
      const main = document.querySelector('.play-page') || document.body;
      main.appendChild(wait);
    }
    const displayCode = code || '······';
    wait.innerHTML = `
      <div class="invite-card">
        <h2>Waiting for opponent</h2>
        <p class="invite-sub">Share this code or link:</p>
        <div class="invite-code${code ? '' : ' placeholder'}">${displayCode}</div>
        <div class="invite-status info" id="inviteStatus">Connecting to broker...</div>
        <div class="invite-actions">
          <button type="button" class="btn btn-ghost" id="copyCodeBtn" ${code ? '' : 'disabled'}>Copy code</button>
          <button type="button" class="btn btn-ghost" id="copyLinkBtn" ${code ? '' : 'disabled'}>Copy link</button>
          <button type="button" class="btn btn-ghost" id="cancelInviteBtn">Cancel</button>
        </div>
        <div class="spinner-wrap"><div class="spinner"></div></div>
      </div>
    `;
    wait.removeAttribute('hidden');

    $('cancelInviteBtn').onclick = () => {
      if (this.peer) { try { this.peer.cancel(); } catch (_) {} this.peer = null; }
      this._hideInviteWaiting();
      this._resetState();
      const lob = $('lobby');
      if (lob) lob.removeAttribute('hidden');
    };
  }

  _hideInviteWaiting() {
    const wait = $('inviteWaiting');
    if (wait) wait.setAttribute('hidden', '');
  }

  _updateInviteStatus(text, kind = 'info') {
    const el = $('inviteStatus');
    if (!el) return;
    el.textContent = text;
    el.className = 'invite-status ' + kind;
  }

  _showJoinOverlay(message) {
    let overlay = $('joinOverlay');
    if (!overlay) {
      overlay = document.createElement('section');
      overlay.id = 'joinOverlay';
      overlay.className = 'invite-waiting';
      const main = document.querySelector('.play-page') || document.body;
      main.appendChild(overlay);
    }
    overlay.innerHTML = `
      <div class="invite-card">
        <h2>Joining game</h2>
        <div class="invite-status info" id="joinStatus">${message || 'Connecting to host...'}</div>
        <div class="spinner-wrap"><div class="spinner"></div></div>
      </div>
    `;
    overlay.removeAttribute('hidden');
    const lobby = $('lobby');
    if (lobby) lobby.setAttribute('hidden', '');
    const game = $('game');
    if (game) game.setAttribute('hidden', '');
  }

  _updateJoinStatus(text, kind = 'info') {
    const el = $('joinStatus');
    if (!el) return;
    el.textContent = text;
    el.className = 'invite-status ' + kind;
  }

  _hideJoinOverlay() {
    const overlay = $('joinOverlay');
    if (overlay) overlay.setAttribute('hidden', '');
  }

  async _showJoinErrorModal(message, onRetry) {
    const choice = await confirm({
      title: 'Could not connect to the host',
      message:
        message ||
        'The invite code may be wrong, the host may have left, or your network doesn\u2019t support P2P. Try again or play the engine.',
      confirmLabel: 'Try again',
      cancelLabel: 'Play engine',
    });
    if (choice) {
      if (typeof onRetry === 'function') onRetry();
    } else {
      this._hideJoinOverlay();
      this.startBotGame(10);
    }
  }

  _resetState() {
    this.chess = new Chess();
    this.moveHistory = [];
    this.evalHistory = [];
    this.reviewIndex = -1;
    this.busy = false;
    this.ended = false;
    this.drawOffered = null;
    this.gameId = null;
    this._serverRatingDelta = null;
    this._updatePremoveIndicator(0);
    if (this.peer) { try { this.peer.close(); } catch (_) {} this.peer = null; }
    if (this.socket) { try { this.socket.close(); } catch (_) {} this.socket = null; }
    if (this._matchTicketAbort) {
      try { this._matchTicketAbort.abort(); } catch (_) {}
      this._matchTicketAbort = null;
    }
    if (this.clock) { this.clock.destroy(); this.clock = null; }
    if (this.engine) {
      try { this.engine.quit(); } catch (_) {}
      this.engine = null;
    }
  }

  _initBoard() {
    const mount = $('boardMount');
    if (!mount) return;
    if (this.board) { try { this.board.destroy(); } catch (_) {} this.board = null; }
    this._ensurePremoveIndicator();
    this.board = new Board({
      mountEl: mount,
      orientation: this.myColor,
      interactive: true,
      onMove: (mv) => this._onUserMoveAttempt(mv),
    });
    this.board.onPremoveChange = (n) => this._updatePremoveIndicator(n);
    const humanMode = this.mode === 'bot' || this.mode === 'friend' || this.mode === 'match';
    this.board.setPremoveEnabled(humanMode);
    this.board.setPosition(this.chess);
    this._renderMoves();
  }

  _ensurePremoveIndicator() {
    if (this._premoveIndicatorEl) return this._premoveIndicatorEl;
    const el = document.createElement('div');
    el.className = 'premove-indicator';
    el.textContent = '0 premoves queued';
    el.style.display = 'none';
    const stage = document.querySelector('.board-stage');
    if (stage && stage.parentNode) {
      stage.parentNode.insertBefore(el, stage.nextSibling);
    } else {
      const main = document.querySelector('.game-main');
      if (main) main.appendChild(el);
    }
    this._premoveIndicatorEl = el;
    return el;
  }

  _updatePremoveIndicator(count) {
    const el = this._ensurePremoveIndicator();
    if (!el) return;
    if (count > 0) {
      el.textContent = count + (count === 1 ? ' premove queued' : ' premoves queued');
      el.classList.add('show');
      el.style.display = '';
    } else {
      el.classList.remove('show');
      el.style.display = 'none';
    }
  }

  _initClocks() {
    if (this.clock) this.clock.destroy();
    this.clock = new Clock({
      initialMs: this.timeControl.base * 1000,
      incrementMs: this.timeControl.incr * 1000,
      tickIntervalMs: 100,
      localColor: this.myColor,
      onTick: (snap) => {
        this._updateClockDisplay('w', snap.w / 1000);
        this._updateClockDisplay('b', snap.b / 1000);
        this._onClockTurn(snap.active);
      },
      onFlag: (side) => this._onFlag(side),
    });
    this._updateClockDisplay('w', this.timeControl.base);
    this._updateClockDisplay('b', this.timeControl.base);
  }

  _startGameFlow() {
    this._renderMoves();
    const firstMover = this.chess.turn();
    this.clock.userStopped = false;
    this.clock.active = firstMover;
    this.clock.lastTickAt = performance.now();
    try { this.clock._startTimer(); } catch (_) {}
    this._onClockTurn(firstMover);
    if (this.mode === 'bot' && firstMover === this.botColor) {
      setTimeout(() => this._botMove(), 400);
    }
  }

  _onClockTurn(side) {
    const meIsOn = side === this.myColor;
    const mePanel = document.querySelector('.player-panel.me');
    const oppPanel = document.querySelector('.player-panel.opp');
    if (mePanel) mePanel.classList.toggle('on', meIsOn);
    if (oppPanel) oppPanel.classList.toggle('on', !meIsOn);
    if (this.board) this.board.setInteractive(meIsOn && !this.ended);
    if (meIsOn && !this.ended && this.board && this.board.premoveQueue.length > 0) {
      this._executePremoves();
    }
  }

  _executePremoves() {
    if (!this.board || !this.chess) return;
    while (this.board.premoveQueue.length > 0) {
      if (this.ended) { this.board.clearPremoves(); return; }
      if (this.chess.turn() !== this.myColor) break;
      const pre = this.board.premoveQueue[0];
      const legalMoves = this.chess.moves({ verbose: true });
      const isLegal = legalMoves.some((m) => m.from === pre.from && m.to === pre.to);
      if (!isLegal) {
        this.board.clearPremoves();
        break;
      }
      this.board.premoveQueue.shift();
      this.board._renderPremoves();
      this._onUserMoveAttempt({ from: pre.from, to: pre.to, promotion: pre.promotion });
      if (this.ended) break;
    }
  }

  _updateClockDisplay(side, remaining) {
    const sel = side === this.myColor ? '[data-clock="me"]' : '[data-clock="opp"]';
    const el = document.querySelector(sel);
    if (!el) return;
    el.textContent = formatTime(remaining);
    const panel = el.closest('.player-panel');
    if (panel) {
      const low = el.classList.toggle('low', remaining < 30 && remaining > 0);
      void low;
    }
  }

  _onFlag(side) {
    if (this.ended) return;
    const winner = side === 'w' ? 'b' : 'w';
    const iWon = winner === this.myColor;
    this._endGame(iWon ? 'win' : 'loss', 'flag');
  }

  async _onUserMoveAttempt({ from, to, promotion }) {
    if (this.ended || this.busy) return;
    if (this.chess.turn() !== this.myColor) return;

    let move;
    try {
      move = this.chess.move({ from, to, promotion: promotion || 'q' });
    } catch (e) {
      return;
    }
    if (!move) return;

    this.moveHistory.push({
      verbose: move,
      fenBefore: move.before,
      fenAfter: move.after,
      color: move.color,
      ply: this.moveHistory.length,
    });

    this.board.setPosition(this.chess);
    this._highlightLast(move);
    this._renderMoves();
    this._asyncEval();
    this._maybeAdvanceClock(move.color);

    if (this.peer && this.peer.isOpen) {
      this.peer.send({ t: 'move', from, to, promotion: promotion || 'q', sentAt: Date.now() });
      if (this.clock) {
        this.peer.send({ t: 'clock', color: this.myColor, remaining: this.clock.getRemaining(this.myColor) });
      }
    } else if (this.socket && this.socket.isOpen) {
      this.socket.sendMove(from, to, promotion || 'q');
    }

    if (this.chess.isGameOver()) {
      this._resolveGameEnd();
      return;
    }

    if (this.mode === 'bot') {
      const delay = 400 + Math.random() * 1100;
      setTimeout(() => this._botMove(), delay);
    }
  }

  _highlightLast(move) {
    let checkSq = null;
    if (this.chess.inCheck()) {
      const turn = this.chess.turn();
      const board = this.chess.board();
      outer:
      for (let r = 0; r < 8; r++) {
        for (let f = 0; f < 8; f++) {
          const c = board[r][f];
          if (c && c.type === 'k' && c.color === turn) {
            checkSq = 'abcdefgh'[f] + (8 - r);
            break outer;
          }
        }
      }
    }
    this.board.highlight({ from: move.from, to: move.to, check: checkSq });
  }

  _maybeAdvanceClock(whoMoved) {
    if (!this.clock) return;
    this.clock.onMove(whoMoved);
  }

  async _botMove() {
    if (this.ended) return;
    if (this.chess.turn() !== this.botColor) return;
    this.busy = true;
    this._setThinking(true);
    try {
      const fen = this.chess.fen();
      let bestUci = null;
      if (this.engine) {
        try {
          const result = await this.engine.bestMove({ fen });
          bestUci = result && result.best ? result.best : null;
        } catch (engErr) {
          bestUci = null;
        }
      }
      if (!bestUci) bestUci = this._greedyFallbackMove();
      const from = bestUci.slice(0, 2);
      const to = bestUci.slice(2, 4);
      const promo = bestUci.length >= 5 ? bestUci.slice(4, 5) : undefined;
      let move;
      try {
        move = this.chess.move({ from, to, promotion: promo });
      } catch (e) {
        move = null;
      }
      if (!move) {
        const fb = this._greedyFallbackMove();
        if (fb) {
          try {
            move = this.chess.move({
              from: fb.slice(0, 2),
              to: fb.slice(2, 4),
              promotion: fb.length >= 5 ? fb.slice(4, 5) : undefined,
            });
          } catch (_) { move = null; }
        }
      }
      if (move) {
        this.moveHistory.push({
          verbose: move,
          fenBefore: move.before,
          fenAfter: move.after,
          color: move.color,
          ply: this.moveHistory.length,
        });
        this.board.setPosition(this.chess);
        this._highlightLast(move);
        this._renderMoves();
        this._asyncEval();
        this._maybeAdvanceClock(move.color);
        if (this.chess.isGameOver()) {
          this._resolveGameEnd();
          return;
        }
      }
    } catch (err) {
      toast({ title: 'Bot error', message: err.message || 'engine move failed', kind: 'bad' });
    } finally {
      this._setThinking(false);
      this.busy = false;
    }
  }

  _greedyFallbackMove() {
    const moves = this.chess.moves({ verbose: true });
    if (!moves.length) return null;
    const score = (m) => {
      let s = 0;
      if (m.captured) s += { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 }[m.captured] || 0;
      if (m.promotion) s += 800;
      const centerDist = Math.abs(4.5 - (m.to.charCodeAt(0) - 97)) + Math.abs(4.5 - (parseInt(m.to[1]) - 1));
      s += (8 - centerDist) * 3;
      if (m.san.includes('+')) s += 50;
      return s;
    };
    moves.sort((a, b) => score(b) - score(a));
    const top = moves.filter((m) => score(m) >= score(moves[0]) - 30);
    const pick = top[Math.floor(Math.random() * top.length)];
    return pick.lan || (pick.from + pick.to + (pick.promotion || ''));
  }

  _setThinking(on) {
    const t = $('thinking');
    if (!t) return;
    if (on && this.mode === 'bot' && this.chess.turn() === this.botColor) {
      t.hidden = false;
      const span = t.querySelector('span');
      if (span) span.textContent = 'Engine thinking\u2026';
    } else {
      t.hidden = true;
    }
  }

  async _asyncEval() {
    if (!this.engine) return;
    const fen = this.chess.fen();
    const sideToMove = this.chess.turn();
    try {
      const info = await this.engine.analyze({ fen, depth: 16, movetime: 1500 });
      this.evalHistory.push({ fen, info, sideToMove });
      this._renderEval(info);
    } catch (_) {}
  }

  _skillToLevel(skill) {
    return Math.max(1, Math.min(8, Math.round((Math.max(1, Math.min(20, skill)) / 20) * 8)));
  }

  _renderEval(info) {
    const fill = $('evalFill');
    const score = $('evalScore');
    const depth = $('evalDepth');
    if (!fill || !info) return;
    let cp = info.cp;
    if (cp == null && info.mate != null) {
      cp = info.mate > 0 ? 10000 - info.mate * 100 : -10000 - info.mate * 100;
    }
    if (cp == null) return;
    const perspective = this.myColor === 'w' ? cp : -cp;
    const clamped = Math.max(-1000, Math.min(1000, perspective));
    const winPct = 1 / (1 + Math.pow(10, -clamped / 400));
    const pct = Math.max(2, Math.min(98, winPct * 100));
    fill.style.height = pct + '%';
    if (score) {
      if (info.mate != null) {
        const m = info.mate;
        score.textContent = (m > 0 ? 'M' : '-M') + Math.abs(m);
      } else {
        const val = (perspective / 100).toFixed(1);
        score.textContent = (perspective >= 0 ? '+' : '') + val;
      }
    }
    if (depth && info.depth) depth.textContent = 'depth ' + info.depth;
  }

  _renderMoves() {
    const list = $('movesList');
    if (!list) return;
    const hist = this.moveHistory;
    const html = [];
    for (let i = 0; i < hist.length; i += 2) {
      const moveNo = Math.floor(i / 2) + 1;
      const w = hist[i];
      const b = hist[i + 1];
      html.push('<li class="move-row">');
      html.push('<span class="move-num">' + moveNo + '.</span>');
      html.push('<span class="move-cell' + (this.reviewIndex === i ? ' active' : '') + '" data-ply="' + i + '">' +
        (w ? this._formatSan(w.verbose.san) : '') + '</span>');
      if (b) {
        html.push('<span class="move-cell' + (this.reviewIndex === i + 1 ? ' active' : '') + '" data-ply="' + (i + 1) + '">' +
          this._formatSan(b.verbose.san) + '</span>');
      } else {
        html.push('<span class="move-cell empty"></span>');
      }
      html.push('</li>');
    }
    list.innerHTML = html.join('');
    const card = list.closest('.moves-card') || list.parentElement;
    if (card) list.scrollTop = list.scrollHeight;
    list.querySelectorAll('.move-cell:not(.empty)').forEach((cell) => {
      cell.addEventListener('click', () => {
        const ply = parseInt(cell.dataset.ply, 10);
        this._reviewMove(ply);
      });
    });
  }

  _formatSan(san) {
    return san || '';
  }

  _reviewMove(ply) {
    if (ply < 0 || ply >= this.moveHistory.length) return;
    this.reviewIndex = ply;
    const item = this.moveHistory[ply];
    const review = new Chess(item.fenBefore);
    this.board.chess = review;
    this.board.setPosition(review);
    const move = item.verbose;
    this.board.highlight({ from: move.from, to: move.to });
    this._renderMoves();
  }

  _resolveGameEnd() {
    if (this.ended) return;
    let result, ending;
    if (this.chess.isCheckmate()) {
      const winner = this.chess.turn() === 'w' ? 'b' : 'w';
      result = winner === this.myColor ? 'win' : 'loss';
      ending = 'checkmate';
    } else if (this.chess.isStalemate()) {
      result = 'draw'; ending = 'stalemate';
    } else if (this.chess.isThreefoldRepetition()) {
      result = 'draw'; ending = 'threefold';
    } else if (this.chess.isInsufficientMaterial()) {
      result = 'draw'; ending = 'insufficient';
    } else if (this.chess.isDraw()) {
      result = 'draw'; ending = 'fifty-move';
    } else {
      result = 'draw'; ending = 'unknown';
    }
    this._endGame(result, ending);
  }

  async _endGame(result, ending) {
    if (this.ended) return;
    this.ended = true;
    if (this.clock) this.clock.stop();
    if (this.board) {
      this.board.clearPremoves();
      this.board.setInteractive(false);
    }
    this._updatePremoveIndicator(0);
    this._setThinking(false);

    const oppRating = (this.opponent && this.opponent.rating) || 1200;
    const score = result === 'win' ? 1 : result === 'draw' ? 0.5 : 0;

    const analysis = this._analyzeMyMoves();
    const estElo = accuracyToElo(analysis.accuracy);

    let oldRating = (this.user && this.user.rating) || 1200;
    let newRating = oldRating;
    let delta = 0;
    try {
      const before = store.getUser() || this.user;
      oldRating = Math.round(before.rating || 1200);
      if (this.mode === 'match' && this._serverRatingDelta != null) {
        delta = Math.round(this._serverRatingDelta);
        newRating = Math.max(0, oldRating + delta);
        try {
          store.updateRating(delta, oppRating, result);
        } catch (_) {}
      } else {
        const updated = store.updateRating(0, oppRating, result);
        newRating = Math.round((updated && updated.rating) || oldRating);
        delta = newRating - oldRating;
      }
      if (analysis.accuracy != null) {
        try { store.setEstimatedElo(estElo); } catch (_) {}
      }
      const game = {
        opponentKind: this.opponent && this.opponent.kind || this.mode,
        opponentName: this.opponent && this.opponent.name || 'Unknown',
        opponentRating: oppRating,
        color: this.myColor,
        result, ending,
        pgn: this.chess.pgn(),
        moves: this.moveHistory.map((m) => ({
          san: m.verbose.san,
          from: m.verbose.from,
          to: m.verbose.to,
        })),
        accuracy: analysis.accuracy,
        estimatedElo: estElo,
        buckets: analysis.buckets,
        ratingDelta: delta,
        durationMs: 0,
        startedAt: Date.now() - (this.moveHistory.length * 4000),
        endedAt: Date.now(),
        gameId: this.gameId,
        hash: Math.random().toString(36).slice(2),
      };
      await this._saveAndSync(game);
    } catch (_) {}

    this._renderPostGame({ result, ending, oldRating, newRating, delta, analysis, estElo });
    hide($('game'));
    show($('postGame'));
    window.scrollTo({ top: 0, behavior: 'smooth' });

    if (this.socket) {
      try { this.socket.close(); } catch (_) {}
      this.socket = null;
    }
  }

  _analyzeMyMoves() {
    const myMoves = this.moveHistory.filter((m) => m.color === this.myColor);
    const moveData = [];
    for (let i = 0; i < myMoves.length; i++) {
      const m = myMoves[i];
      const myIdx = m.ply;
      const prevMyMove = i > 0 ? myMoves[i - 1] : null;
      const beforeEvalEntry = prevMyMove
        ? this.evalHistory.find((e) => e.fen === prevMyMove.fenAfter)
        : this.evalHistory[0];
      const afterEvalEntry = this.evalHistory.find((e) => e.fen === m.fenAfter);
      const player = m.color;
      const cpBefore = this._evalCpFromPerspective(beforeEvalEntry, player);
      const cpAfter = this._evalCpFromPerspective(afterEvalEntry, player);
      const cpBest = cpAfter;
      const mateBefore = this._evalMateFromPerspective(beforeEvalEntry, player);
      const mateAfter = this._evalMateFromPerspective(afterEvalEntry, player);
      const mateBest = mateAfter;
      moveData.push({
        player,
        cpBefore,
        cpAfter,
        cpBest,
        mateBefore,
        mateAfter,
        mateBest,
        san: m.verbose.san,
      });
    }
    return analyzeGame(moveData);
  }

  _evalCpFromPerspective(entry, playerColor) {
    if (!entry || !entry.info) return null;
    const info = entry.info;
    if (info.cp == null) return null;
    const stm = entry.sideToMove || (entry.info._stm || null);
    if (stm == null) return info.cp;
    return stm === playerColor ? info.cp : -info.cp;
  }

  _evalMateFromPerspective(entry, playerColor) {
    if (!entry || !entry.info) return null;
    const info = entry.info;
    if (info.mate == null) return null;
    const stm = entry.sideToMove || (entry.info._stm || null);
    if (stm == null) return info.mate;
    return stm === playerColor ? info.mate : -info.mate;
  }

  async _saveAndSync(game) {
    try { store.saveGame(game); } catch (_) {}
  }

  _renderPostGame({ result, ending, oldRating, newRating, delta, analysis, estElo }) {
    const callout = document.querySelector('.best-move-callout');
    if (callout) { callout.style.display = 'none'; callout.innerHTML = ''; }

    const banner = $('resultBanner');
    if (banner) {
      banner.classList.remove('loss', 'draw');
      if (result === 'loss') banner.classList.add('loss');
      if (result === 'draw') banner.classList.add('draw');
      const icon = banner.querySelector('.result-icon');
      const h2 = banner.querySelector('h2');
      const p = banner.querySelector('p');
      if (icon) icon.textContent = RESULT_ICONS[result] || '';
      if (h2) h2.textContent = result === 'win' ? 'Victory' : result === 'loss' ? 'Defeat' : 'Draw';
      if (p) p.textContent = this._endingText(result, ending);
    }

    const sub = document.querySelector('.result-subtitle');
    if (sub) sub.textContent = this._encouragingMessage(result, ending, analysis.accuracy);

    const ratingOld = document.querySelector('.rating-old .val');
    const ratingNew = document.querySelector('.rating-new .val');
    const ratingDelta = document.querySelector('.rating-delta');
    if (ratingOld) ratingOld.textContent = oldRating;
    if (ratingNew) ratingNew.textContent = newRating;
    if (ratingDelta) {
      ratingDelta.classList.remove('pos', 'neg', 'zero');
      const sign = delta > 0 ? '+' : '';
      ratingDelta.textContent = sign + delta;
      ratingDelta.classList.add(delta > 0 ? 'pos' : delta < 0 ? 'neg' : 'zero');
    }

    const accNum = document.querySelector('.acc-num');
    if (accNum) accNum.textContent = (analysis.accuracy || 0).toFixed(1) + '%';

    const accQuality = document.querySelector('.acc-quality');
    if (accQuality) {
      const q = this._accuracyQuality(analysis.accuracy || 0);
      accQuality.textContent = q.label;
      accQuality.className = 'acc-quality ' + q.cls;
    }

    const buckets = document.querySelectorAll('.acc-buckets .bucket');
    buckets.forEach((b) => {
      const cls = b.dataset.class;
      const count = analysis.buckets[cls] || 0;
      const c = b.querySelector('.b-count');
      if (c) c.textContent = count;
    });

    const estEloEl = document.querySelector('.est-elo strong');
    if (estEloEl) estEloEl.textContent = estElo;

    this._renderBestMove(analysis);
  }

  _encouragingMessage(result, ending, accuracy) {
    const acc = accuracy || 0;
    if (result === 'win') {
      if (ending === 'resignation' || ending === 'abandoned') return 'Your opponent resigned — you were clearly winning.';
      if (acc >= 85) return 'Excellent game! You played brilliantly.';
      if (acc >= 70) return 'Well played! A solid win.';
      return 'You found a way to win — even if it wasn\'t always pretty!';
    }
    if (result === 'loss') {
      if (ending === 'flag') return 'Time ran out. Try a longer time control next time.';
      if (acc >= 85) return 'Tough loss, but you played well. The rating will catch up.';
      if (acc >= 70) return 'Good fight. Review your mistakes and come back stronger.';
      return 'Every loss is a lesson. Check the analysis and try again!';
    }
    return 'A balanced game! Small improvements will tip the scale next time.';
  }

  _accuracyQuality(acc) {
    if (acc >= 95) return { label: 'Outstanding', cls: 'outstanding' };
    if (acc >= 90) return { label: 'Excellent', cls: 'excellent' };
    if (acc >= 80) return { label: 'Good', cls: 'good' };
    if (acc >= 70) return { label: 'Fair', cls: 'fair' };
    if (acc >= 60) return { label: 'Inaccurate', cls: 'inaccurate' };
    return { label: 'Needs work', cls: 'needs-work' };
  }

  _renderBestMove(analysis) {
    const container = document.querySelector('.best-move-callout');
    if (!container || !analysis.perMove || analysis.perMove.length === 0) return;

    const brilliant = analysis.perMove.find(m => m.classification === 'brilliant');
    if (brilliant) {
      container.innerHTML = '<span class="bm-icon">' + this._svgStar() + '</span><span class="bm-text">You found a brilliant move! <strong>' + brilliant.san + '</strong> — a move worthy of the masters.</span>';
      container.style.display = 'flex';
      return;
    }

    const sorted = [...analysis.perMove].sort((a, b) => b.accuracy - a.accuracy);
    const best = sorted[0];
    if (best && best.accuracy >= 90) {
      container.innerHTML = '<span class="bm-icon">' + this._svgCheck() + '</span><span class="bm-text">Your best move: <strong>' + best.san + '</strong> — keep this up!</span>';
      container.style.display = 'flex';
      return;
    }

    container.style.display = 'none';
  }

  _svgStar() {
    return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
  }

  _svgCheck() {
    return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
  }

  _endingText(result, ending) {
    const moveCount = Math.ceil(this.moveHistory.length / 2);
    if (result === 'win') {
      if (ending === 'checkmate') return 'Checkmate in ' + moveCount + ' moves';
      if (ending === 'flag') return 'Opponent ran out of time';
      if (ending === 'resignation') return 'Opponent resigned';
      if (ending === 'abandoned') return 'Opponent disconnected';
      return 'Won on time';
    }
    if (result === 'loss') {
      if (ending === 'checkmate') return 'Checkmate in ' + moveCount + ' moves';
      if (ending === 'flag') return 'You ran out of time';
      if (ending === 'resign') return 'You resigned';
      return 'Lost on time';
    }
    const map = {
      stalemate: 'Stalemate',
      threefold: 'Threefold repetition',
      insufficient: 'Insufficient material',
      'fifty-move': 'Fifty-move rule',
      agreement: 'Draw by agreement',
      unknown: 'Draw',
    };
    return map[ending] || 'Draw';
  }

  _wireGameControls() {
    const resign = $('resignBtn');
    if (resign) resign.addEventListener('click', async () => {
      if (this.ended || !this.chess) return;
      const ok = await confirm({
        title: 'Resign?',
        message: 'You will lose this game.',
        danger: true,
        confirmLabel: 'Resign',
      });
      if (!ok) return;
      if (this.peer && this.peer.isOpen) {
        try { this.peer.send({ t: 'resign' }); } catch (_) {}
      } else if (this.socket && this.socket.isOpen) {
        try { this.socket.sendResign(); } catch (_) {}
      }
      this._endGame('loss', 'resign');
    });

    const draw = $('drawBtn');
    if (draw) draw.addEventListener('click', async () => {
      if (this.ended || !this.chess) return;
      if (this.mode === 'bot') {
        const evalEntry = this.evalHistory[this.evalHistory.length - 1];
        const cp = evalEntry && evalEntry.info && evalEntry.info.cp;
        const accept = cp != null && Math.abs(cp) < 60;
        if (accept) this._endGame('draw', 'agreement');
        else toast({ title: 'Draw declined', message: 'The engine plays on.', kind: 'info' });
      } else if (this.socket && this.socket.isOpen) {
        if (this.drawOffered && this.drawOffered !== this.myColor) {
          try { this.socket.sendDrawAccept(); } catch (_) {}
          return;
        }
        this.drawOffered = this.myColor;
        try { this.socket.sendDrawOffer(); } catch (_) {}
        toast({ title: 'Draw offered', message: 'Waiting for your opponent.', kind: 'info' });
      } else if (this.peer && this.peer.isOpen) {
        if (this.drawOffered && this.drawOffered !== this.myColor) {
          this._endGame('draw', 'agreement');
          return;
        }
        this.drawOffered = this.myColor;
        try { this.peer.send({ t: 'draw_offer' }); } catch (_) {}
        toast({ title: 'Draw offered', message: 'Waiting for your opponent.', kind: 'info' });
      } else {
        this._endGame('draw', 'agreement');
      }
    });

    const flip = $('flipBtn');
    if (flip) flip.addEventListener('click', () => {
      if (this.board) this.board.flip();
    });

    const takeback = $('takebackBtn');
    if (takeback) takeback.addEventListener('click', () => {
      if (this.ended) return;
      if (this.mode !== 'bot') {
        toast({ title: 'No takebacks', message: 'Takebacks are only available vs. the engine.', kind: 'info' });
        return;
      }
      this._takeback();
    });
  }

  _takeback() {
    if (this.moveHistory.length < 2) {
      toast({ title: 'Nothing to undo', message: 'No moves to take back yet.', kind: 'info' });
      return;
    }
    let undoCount = this.chess.turn() === this.myColor ? 2 : 1;
    while (undoCount-- > 0 && this.moveHistory.length) {
      this.chess.undo();
      this.moveHistory.pop();
      this.evalHistory.pop();
    }
    this.board.setPosition(this.chess);
    this._renderMoves();
    if (this.clock) this.clock.onMove(this.chess.turn());
    if (this.board) this.board.clearPremoves();
    toast({ title: 'Move taken back', message: 'It is your move again.', kind: 'good' });
  }

  _wirePostGame() {
    const review = $('reviewBtn');
    if (review) review.addEventListener('click', () => {
      hide($('postGame'));
      show($('game'));
      if (this.moveHistory.length) {
        this._reviewMove(this.moveHistory.length - 1);
      }
    });

    const rematch = $('rematchBtn');
    if (rematch) rematch.addEventListener('click', async () => {
      hide($('postGame'));
      if (this.mode === 'bot') {
        await this.startBotGame(this.skillLevel);
      } else {
        show($('lobby'));
      }
    });
  }

  _refreshMePanel() {
    const name = document.querySelector('.player-panel.me .pp-name');
    const rating = document.querySelector('.player-panel.me .pp-rating');
    if (name) name.textContent = (this.user && this.user.handle) || 'You';
    if (rating) rating.textContent = (this.user && this.user.rating) ? Math.round(this.user.rating) : '1200';
  }

  _refreshOppPanel() {
    const name = document.querySelector('.player-panel.opp .pp-name');
    const rating = document.querySelector('.player-panel.opp .pp-rating');
    if (name && this.opponent) name.textContent = this.opponent.name;
    if (rating && this.opponent) {
      rating.textContent = this.opponent.rating != null ? this.opponent.rating : '\u2014';
    }
  }
}

const ctrl = new GameController();
if (typeof window !== 'undefined') window.__cr = Object.assign(window.__cr || {}, { _controller: ctrl });
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => ctrl.init());
} else {
  ctrl.init();
}

export { GameController };

if (typeof window !== 'undefined') {
  window.__cr = window.__cr || {};
  window.__cr.getController = () => window.__cr._controller;
}
