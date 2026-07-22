#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

echo "== ChessRight worker file list =="
ls -1 .
echo
echo "== src/ =="
ls -1 src/
echo

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is not on PATH; cannot syntax-check"
  exit 1
fi

echo "== Syntax check (node --check) =="
fail=0
for f in src/*.js; do
  if node --check "$f"; then
    echo "  ok: $f"
  else
    echo "  FAIL: $f"
    fail=$((fail + 1))
  fi
done

if [ "$fail" -ne 0 ]; then
  echo
  echo "FAILED: $fail file(s) had syntax errors"
  exit 1
fi

echo
echo "All files syntax-checked cleanly."
