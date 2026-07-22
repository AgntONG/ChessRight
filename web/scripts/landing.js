(function () {
  'use strict';

  var GLYPH = { k: '\u265A', q: '\u265B', r: '\u265C', b: '\u265D', n: '\u265E', p: '\u265F' };
  var FILES = 'abcdefgh';

  var STARTING = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';

  var GAME = [
    ['d4','e6'],['e4','d5'],['Nc3','c5'],['Nf3','Nc6'],
    ['exd5','exd5'],['Be2','Nf6'],['O-O','Be7'],['Bg5','O-O'],
    ['dxc5','Be6'],['Nd4','Bxc5'],['Nxe6','fxe6'],['Bg4','Qd6'],
    ['Bh3','Rae8'],['Qd2','Bb4'],['Bxf6','Rxf6'],['Rad1','Qc5'],
    ['Qe2','Bxc3'],['bxc3','Qxc3'],['Rxd5','Nd4'],['Qh5','Ref8'],
    ['Re5','Rh6'],['Qf5','Rxh3'],['Rc5','Qg3!!']
  ];

  var uciPairs = [
    ['d2d4','e7e6'],['e2e4','d7d5'],['b1c3','c7c5'],['g1f3','b8c6'],
    ['e4d5','e6d5'],['f1e2','g8f6'],['e1g1','f8e7'],['c1g5','e8g8'],
    ['d4c5','c8e6'],['f3d4','e7c5'],['d4e6','f7e6'],['e2g4','d8d6'],
    ['g4h3','a8e8'],['d1d2','c5b4'],['g5f6','f8f6'],['a1d1','d6c5'],
    ['d2e2','b4c3'],['b2c3','c5c3'],['d1d5','c6d4'],['e2h5','e8f8'],
    ['d5e5','f6h6'],['h5f5','h6h3'],['e5c5','c3g3']
  ];

  var BRILLIANT_PLY = 45;
  var HOLD_MS = 6200;
  var RESTART_MS = 1100;

  var boardEl, badgeEl, flashEl, coinsEl, labelEl, moveListEl;
  var squares = {};
  var pieces = {};
  var pieceSeq = 0;
  var ply = -1;
  var state = {};
  var timer = null;
  var running = true;
  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function startingState() {
    var s = {};
    var rows = STARTING.split('/');
    var seq = 0;
    for (var r = 0; r < 8; r++) {
      var rank = 8 - r;
      var file = 0;
      for (var c = 0; c < rows[r].length; c++) {
        var ch = rows[r][c];
        if (/\d/.test(ch)) { file += parseInt(ch, 10); continue; }
        var sq = FILES[file] + rank;
        s[sq] = { color: ch === ch.toUpperCase() ? 'w' : 'b', type: ch.toLowerCase(), id: 'p' + seq++ };
        file++;
      }
    }
    return s;
  }

  function buildSquares() {
    var html = '';
    for (var r = 8; r >= 1; r--) {
      for (var f = 0; f < 8; f++) {
        var sq = FILES[f] + r;
        var light = (f + r) % 2 === 0;
        html += '<div class="sq ' + (light ? 'lt' : 'dk') + '" data-sq="' + sq + '">';
        if (f === 0) html += '<i class="rk">' + r + '</i>';
        if (r === 1) html += '<i class="fl">' + FILES[f] + '</i>';
        html += '</div>';
      }
    }
    boardEl.innerHTML = html;
    boardEl.querySelectorAll('.sq').forEach(function (el) {
      squares[el.dataset.sq] = el;
    });
  }

  function placePiece(el, sq) {
    var f = sq.charCodeAt(0) - 97;
    var r = parseInt(sq[1], 10);
    el.style.left = (f * 12.5) + '%';
    el.style.top = ((8 - r) * 12.5) + '%';
  }

  function makePieceEl(piece) {
    var el = document.createElement('div');
    el.className = 'pc ' + piece.color;
    el.dataset.id = piece.id;
    el.textContent = GLYPH[piece.type];
    return el;
  }

  function syncPieces() {
    var live = {};
    Object.keys(state).forEach(function (sq) {
      var piece = state[sq];
      live[piece.id] = sq;
      var el = pieces[piece.id];
      if (!el) {
        el = makePieceEl(piece);
        pieces[piece.id] = el;
        el.dataset.sq = sq;
        placePiece(el, sq);
        boardEl.appendChild(el);
      } else if (el.dataset.sq !== sq) {
        el.dataset.sq = sq;
        placePiece(el, sq);
      }
    });
    Object.keys(pieces).forEach(function (id) {
      if (!live[id]) {
        var el = pieces[id];
        el.classList.add('gone');
        setTimeout(el.remove.bind(el), reducedMotion ? 0 : 320);
        delete pieces[id];
      }
    });
  }

  function clearHighlights() {
    Object.keys(squares).forEach(function (sq) {
      squares[sq].classList.remove('from', 'to', 'brill');
    });
  }

  function highlight(from, to) {
    clearHighlights();
    if (squares[from]) squares[from].classList.add('from');
    if (squares[to]) squares[to].classList.add('to');
  }

  function buildMoveList() {
    var html = '';
    for (var i = 0; i < GAME.length; i++) {
      var num = i + 1;
      html += '<span class="mn">' + num + '.</span>';
      html += '<span class="mv" data-ply="' + (i * 2) + '">' + GAME[i][0] + '</span>';
      html += '<span class="mv" data-ply="' + (i * 2 + 1) + '">' + GAME[i][1] + '</span>';
    }
    moveListEl.innerHTML = html;
  }

  function setActiveMove(p) {
    moveListEl.querySelectorAll('.mv').forEach(function (m) {
      m.classList.remove('on', 'star');
    });
    if (p < 0) return;
    var el = moveListEl.querySelector('.mv[data-ply="' + p + '"]');
    if (!el) return;
    el.classList.add('on');
    if (p === BRILLIANT_PLY) el.classList.add('star');
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) {}
  }

  function applyUci(from, to) {
    var piece = state[from];
    if (!piece) return;
    delete state[from];
    if (state[to]) delete state[to];
    state[to] = piece;
  }

  function moveToPly(target) {
    state = startingState();
    for (var i = 0; i <= target; i++) {
      var uci = uciPairs[Math.floor(i / 2)][i % 2];
      applyUci(uci.slice(0, 2), uci.slice(2, 4));
    }
    syncPieces();
    if (target < 0) {
      clearHighlights();
      setActiveMove(-1);
      return;
    }
    var last = uciPairs[Math.floor(target / 2)][target % 2];
    highlight(last.slice(0, 2), last.slice(2, 4));
    setActiveMove(target);
    labelEl.textContent = GAME[Math.floor(target / 2)][target % 2];
  }

  function clearTimer() { if (timer) { clearTimeout(timer); timer = null; } }
  function setTimer(fn, ms) { clearTimer(); timer = setTimeout(fn, ms); }

  function resetEffects() {
    badgeEl.classList.remove('show');
    flashEl.classList.remove('go');
    coinsEl.innerHTML = '';
  }

  function speedFor(p) {
    if (p >= BRILLIANT_PLY - 2) return 620;
    if (p >= BRILLIANT_PLY - 5) return 500;
    return 380;
  }

  function fireBrilliancy() {
    var move = uciPairs[Math.floor(BRILLIANT_PLY / 2)][BRILLIANT_PLY % 2];
    var from = move.slice(0, 2);
    var to = move.slice(2, 4);
    if (squares[from]) squares[from].classList.add('brill');
    if (squares[to]) squares[to].classList.add('brill');
    flashEl.classList.remove('go');
    void flashEl.offsetWidth;
    flashEl.classList.add('go');
    setTimeout(function () { badgeEl.classList.add('show'); }, 180);
    spawnCoins();
  }

  function spawnCoins() {
    if (reducedMotion) return;
    var count = 28;
    for (var i = 0; i < count; i++) {
      setTimeout(function () {
        var coin = document.createElement('div');
        coin.className = 'coin';
        coin.style.left = (3 + Math.random() * 94) + '%';
        coin.style.width = coin.style.height = (13 + Math.random() * 9) + 'px';
        coin.style.animationDuration = (1.1 + Math.random() * 0.9) + 's';
        coin.style.animationDelay = (Math.random() * 0.3) + 's';
        coinsEl.appendChild(coin);
        setTimeout(function () { coin.remove(); }, 2600);
      }, Math.random() * 800);
    }
  }

  function stop() { running = false; clearTimer(); }
  function start() { running = true; tick(); }

  function tick() {
    if (!running) return;
    ply++;
    if (ply > BRILLIANT_PLY) {
      setTimer(restart, HOLD_MS);
      return;
    }
    moveToPly(ply);
    if (ply === BRILLIANT_PLY) {
      setTimeout(fireBrilliancy, 360);
      setTimer(restart, HOLD_MS);
      return;
    }
    setTimer(tick, speedFor(ply));
  }

  function restart() {
    ply = -1;
    resetEffects();
    moveToPly(-1);
    labelEl.textContent = 'The Gold Coins Game';
    setTimer(tick, RESTART_MS);
  }

  function togglePlay() {
    if (running) stop();
    else start();
  }

  function replay() {
    stop();
    restart();
    setTimer(start, 500);
  }

  var evalData = [
    { d: 1,  e:  4.5 }, { d: 5,  e:  3.1 }, { d: 10, e:  1.0 },
    { d: 15, e: -0.6 }, { d: 20, e: -2.1 }, { d: 25, e: -3.6 }, { d: 30, e: -4.8 }
  ];

  function buildEvalChart() {
    var el = document.getElementById('evalBars');
    if (!el) return;
    el.innerHTML = evalData.map(function (d) {
      var v = Math.max(-5, Math.min(5, d.e));
      var neg = v < 0;
      var mag = Math.abs(v) * 10;
      var top = neg ? 50 : (50 - mag);
      return '<div class="bar' + (neg ? ' neg' : '') + '"><div class="fill" style="top:' + top + '%;height:' + mag + '%"></div></div>';
    }).join('');
  }

  function animateEvalOnScroll() {
    var chart = document.getElementById('evalChart');
    if (!chart || !('IntersectionObserver' in window)) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        chart.querySelectorAll('.fill').forEach(function (f) {
          f.style.animation = 'none';
          void f.offsetWidth;
          f.style.animation = '';
        });
        io.unobserve(chart);
      });
    }, { threshold: 0.35 });
    io.observe(chart);
  }

  function setupNav() {
    var nav = document.getElementById('nav');
    var onScroll = function () {
      nav.classList.toggle('scrolled', window.scrollY > 24);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    var toggle = document.getElementById('menuToggle');
    var menu = document.getElementById('mobileMenu');
    if (toggle && menu) {
      toggle.addEventListener('click', function () {
        var open = toggle.getAttribute('aria-expanded') === 'true';
        toggle.setAttribute('aria-expanded', String(!open));
        menu.classList.toggle('open', !open);
      });
      menu.querySelectorAll('a').forEach(function (a) {
        a.addEventListener('click', function () {
          toggle.setAttribute('aria-expanded', 'false');
          menu.classList.remove('open');
        });
      });
    }
  }

  function setupControls() {
    var replayBtn = document.getElementById('replayBtn');
    if (replayBtn) replayBtn.addEventListener('click', replay);

    var pp = document.getElementById('playPauseBtn');
    var pIcon = document.getElementById('playIcon');
    var sIcon = document.getElementById('pauseIcon');
    var label = document.getElementById('playPauseText');
    if (pp) pp.addEventListener('click', function () {
      var nowPlaying = !running;
      if (nowPlaying) {
        sIcon.style.display = '';
        pIcon.style.display = 'none';
        label.textContent = 'Pause';
        start();
      } else {
        sIcon.style.display = 'none';
        pIcon.style.display = '';
        label.textContent = 'Play';
        stop();
      }
    });
  }

  function setYear() {
    var y = document.getElementById('year');
    if (y) y.textContent = new Date().getFullYear();
  }

  function verifyPosition() {
    var probe = startingState();
    for (var i = 0; i < BRILLIANT_PLY; i++) {
      var uci = uciPairs[Math.floor(i / 2)][i % 2];
      var piece = probe[uci.slice(0, 2)];
      if (!piece) return;
      delete probe[uci.slice(0, 2)];
      if (probe[uci.slice(2, 4)]) delete probe[uci.slice(2, 4)];
      probe[uci.slice(2, 4)] = piece;
    }
    var rows = [];
    for (var r = 8; r >= 1; r--) {
      var row = '', empty = 0;
      for (var f = 0; f < 8; f++) {
        var sq = FILES[f] + r;
        var p = probe[sq];
        if (!p) { empty++; continue; }
        if (empty) { row += empty; empty = 0; }
        row += p.color === 'w' ? p.type.toUpperCase() : p.type;
      }
      if (empty) row += empty;
      rows.push(row);
    }
    var fen = rows.join('/');
    var expected = '5rk1/pp4pp/4p3/2R2Q2/3n4/2q4r/P1P2PPP/5RK1';
    if (fen === expected) {
      window.console && console.log('%c\u265E ChessRight — position verified', 'color:#d4af37');
    } else {
      window.console && console.error('FEN mismatch', fen, expected);
    }
  }

  function init() {
    boardEl = document.getElementById('board');
    badgeEl = document.getElementById('brilliantBadge');
    flashEl = document.getElementById('brilliantFlash');
    coinsEl = document.getElementById('coinsLayer');
    labelEl = document.getElementById('moveLabel');
    moveListEl = document.getElementById('moveList');

    buildSquares();
    buildMoveList();
    buildEvalChart();
    animateEvalOnScroll();
    setupNav();
    setupControls();
    setYear();
    verifyPosition();

    state = startingState();
    syncPieces();
    setActiveMove(-1);
    setTimer(tick, 1300);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
