import { Engine } from './engine.js';

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const TEST_DEPTH = 10;

export async function runEngineTest({ depth = TEST_DEPTH, cdnUrl } = {}) {
  const engine = new Engine({
    cdnUrl: cdnUrl || 'https://cdn.jsdelivr.net/npm/stockfish@16.0.0/src/stockfish-nnue-16-single.js',
    onError: (err) => console.error('[engine] error:', err.message),
    onLoad: () => console.log('[engine] loaded'),
  });

  console.log(`[test] analyzing startpos to depth ${depth}...`);
  const t0 = performance.now();

  let lastInfo = null;
  const finalInfo = await engine.analyze({
    fen: STARTING_FEN,
    depth,
    onInfo: (info) => {
      lastInfo = info;
      if (info.depth != null && info.depth % 5 === 0) {
        const score = info.mate != null ? `M${info.mate}` : `${info.cp}`;
        console.log(`[test] depth=${info.depth} cp=${score}`);
      }
    },
  });

  const dt = Math.round(performance.now() - t0);
  console.log('[test] ---- final ----');
  console.log('[test] best   :', finalInfo.best);
  console.log('[test] ponder :', finalInfo.ponder);
  console.log('[test] cp     :', finalInfo.cp, finalInfo.mate != null ? `(mate ${finalInfo.mate})` : '');
  console.log('[test] mate   :', finalInfo.mate);
  console.log('[test] depth  :', finalInfo.depth);
  console.log('[test] pv     :', (finalInfo.pv || []).slice(0, 8).join(' '));
  console.log(`[test] elapsed: ${dt}ms`);

  engine.quit();
  return finalInfo;
}

if (typeof window !== 'undefined') {
  window.runEngineTest = runEngineTest;
  console.log('[test] call window.runEngineTest() to run, or it will auto-run in 0ms');
  setTimeout(() => {
    runEngineTest().catch((err) => console.error('[test] failed:', err));
  }, 0);
}
