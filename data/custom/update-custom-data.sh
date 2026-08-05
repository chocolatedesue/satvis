#!/usr/bin/env bash
set -u
cd "${0%/*}"

# Run each plugin's sync.sh to collect its data into data/custom/dist, which
# vite.config.ts copies into data/ at build time.
DATA_DIR="$(readlink -f ../)"
OUT_DIR="$(readlink -f dist)"

rm -r "$OUT_DIR/"*

for dir in */; do
  sync=${dir}sync.sh
  if [ -f "$sync" ]; then
    echo "Running $sync"
    bash $sync "$DATA_DIR" "$OUT_DIR"
  fi
done

exit 0
