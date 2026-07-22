# Stockfish WASM (vendored)

This directory vendors the Stockfish chess engine compiled to WebAssembly so
that `web/scripts/play/engine.js` can spawn a local worker without relying on
a CDN hit (and without CORS issues).

## What is this

- **Stockfish.js 16** — the single-threaded WASM build from the
  [`stockfish`](https://www.npmjs.com/package/stockfish) npm package, published
  by Chess.com, LLC under the **GPLv3** license.
- Upstream sources:
  - <https://github.com/nmrugg/stockfish.js> (Emscripten wrapper)
  - <https://github.com/nmrugg/stockfish> (engine)
  - <https://github.com/niklasf/stockfish.wasm> (original WASM port)

## Files

| File                              | Size   | Purpose                                              |
| --------------------------------- | ------ | ---------------------------------------------------- |
| `stockfish-nnue-16-single.js`     | ~25 KB | Emscripten loader, spawned as a Web Worker           |
| `stockfish-nnue-16-single.wasm`   | ~575 KB | The engine binary (single-threaded; NNUE net is NOT embedded) |
| `nn-5af11540bbfe.nnue`            | ~40 MB | The NNUE evaluation network. Required for NNUE-backed eval (~250 Elo stronger than classical). Fetched as a sibling by the engine on first `Use NNUE true`, then cached in IndexedDB. |
| `README.md`                       | —      | This file                                            |

### Why the NNUE net is vendored (40 MB)

The single-threaded build does NOT embed the NNUE net (unlike the multi-threaded
`stockfish-nnue-16.*` build, which embeds it in a larger wasm). The engine
defaults to `Use NNUE value false` and falls back to classical eval until the
net is available. With the net present as a sibling file, `engine.js` sets
`Use NNUE value true` during the handshake; the engine fetches the net once,
parses it (~750 ms one-time), and caches the bytes in the Emscripten
`emscripten_filesystem` IndexedDB store so subsequent loads are near-instant.

Measured impact (Kiwipete `r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1`, depth 18):
classical eval reports `cp = -104`; NNUE reports `cp = -163`. The ~60 cp gap is
the well-known NNUE accuracy improvement and translates to roughly 250 Elo at
fixed depth on single-thread WASM.

If the net is missing or fails to download, `engine.js` detects the
`"Failed to download eval file."` diagnostic, flips `Use NNUE` back to `false`,
and continues with classical eval (no crash, no hang).

## Filename convention — do NOT rename

The npm package `stockfish@16` does **not** ship `stockfish-single.js` (that
name was used by much older versions). The single-threaded build in 16.x is
`stockfish-nnue-16-single.{js,wasm}`.

The string `stockfish-nnue-16-single.wasm` is **hardcoded inside the JS loader**
(in three places) as the wasm filename it fetches relative to its own location.
Both files MUST live side-by-side in the same directory and MUST keep these
exact names. If you rename them, the worker will 404 on the wasm.

`web/scripts/play/engine.js` and `web/scripts/play/engine.test.js` reference
this directory via `../../assets/stockfish/stockfish-nnue-16-single.js` with a
CDN fallback to
`https://cdn.jsdelivr.net/npm/stockfish@16.0.0/src/stockfish-nnue-16-single.js`.

## How the loader finds the wasm

When spawned as a worker with no `#hash`, the loader computes `p` = the
directory of its own URL and then resolves the wasm at `p + "stockfish-nnue-16-single.wasm"`.
So as long as both files are siblings in this folder, it works on any static
host (including `file://`-style local servers).

## How to update

To re-download (e.g. to pick up a newer Stockfish 16.x patch):

```bash
cd web/assets/stockfish
curl -L -f -o stockfish-nnue-16-single.js \
  https://cdn.jsdelivr.net/npm/stockfish@16.0.0/src/stockfish-nnue-16-single.js
curl -L -f -o stockfish-nnue-16-single.wasm \
  https://cdn.jsdelivr.net/npm/stockfish@16.0.0/src/stockfish-nnue-16-single.wasm
curl -L -f -o nn-5af11540bbfe.nnue \
  https://cdn.jsdelivr.net/npm/stockfish@16.0.0/src/nn-5af11540bbfe.nnue
```

Verify the wasm starts with the magic bytes `\0asm` (`00 61 73 6d`):

```bash
python -c "print(open('stockfish-nnue-16-single.wasm','rb').read(4) == b'\x00asm')"
```

### Upgrading to a newer major version (17.x, 18.x)

The filename pattern changes between major versions (e.g. `stockfish-nnue-17-single.*`).
If you upgrade:

1. Download both files from the new version's `src/` directory on jsDelivr.
2. **Delete the old `.js` and `.wasm` files** — do not leave stragglers.
3. Update the two URL constants in `web/scripts/play/engine.js` (and the
   `cdnUrl` default in `web/scripts/play/engine.test.js`) to match the new
   filenames.
4. Note: as of July 2026, `stockfish@18` on npm exceeds jsDelivr's 150 MB
   per-package listing limit, so per-file URLs must be used (the `@version`
   scope still works for individual files even when the directory listing API
   refuses).

## License compliance

Stockfish is GPLv3. Distributing the binaries in this repo means the ChessRight
source code that ships these files must be compatible with GPLv3 terms. See
<https://www.gnu.org/licenses/gpl-3.0.html> and the Stockfish LICENSE.
