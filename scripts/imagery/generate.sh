#!/usr/bin/env bash
# Build the offline base map tileset from Natural Earth II.
#
#   ./generate.sh                    levels 0-5, recolored, verified
#   ./generate.sh --zoom 3           a shallow pyramid, quick pass while iterating
#   ./generate.sh --quality 95       larger tiles, closer to the reference encode
#   ./generate.sh --no-recolor       raw Natural Earth II, without the Cesium grade
#   ./generate.sh --fit-recolor      re-derive the grade from the reference tileset
#   ./generate.sh --help             everything else
#
# This file only builds the image and starts the container. Downloading, the
# recolor, the tiling and the comparison all live in tiles.py so that a run is
# reproducible from the image alone and the host needs nothing but docker.
#
# The generator lives here rather than beside its output because vite copies
# data/** into the build wholesale: anything kept there ships to production, so
# data/ holds the tileset and nothing else. The source raster stays under this
# directory for the same reason — a gigabyte of TIFF that must never be mistaken
# for shippable data.
#
# Three bind mounts:
#   .cache        the source raster, kept between runs
#   data/imagery  the tileset, picked up by vite's data/** copy
#   the old tileset read-only, for the comparison
#
# Both writable mounts are committed directories carrying a .gitignore, so
# neither is created here: a bind mount whose source is missing gets created by
# docker owned by root, which is a worse failure than saying so.
set -euo pipefail

cd "${0%/*}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
IMAGE="satvis-imagery:1"
OUT_DIR="$REPO_ROOT/data/imagery"
REF_DIR="$REPO_ROOT/data/cesium-assets/imagery/NaturalEarthII"

if ! docker info >/dev/null 2>&1; then
  echo "docker is not running — this script keeps GDAL off the host by doing all" >&2
  echo "the work in a container." >&2
  exit 1
fi

for dir in "$PWD/.cache" "$OUT_DIR"; do
  [ -d "$dir" ] && continue
  echo "missing tracked directory: ${dir#"$REPO_ROOT"/}" >&2
  echo "it is committed with a .gitignore inside; restore it with git checkout." >&2
  exit 1
done

echo "building $IMAGE"
docker build --quiet --tag "$IMAGE" . >/dev/null

# The reference is optional: without the submodule the generator still runs, it
# just cannot check its output against the tileset it replaces.
REF_MOUNT=()
if [ -d "$REF_DIR" ]; then
  REF_MOUNT=(--volume "$REF_DIR:/ref:ro")
else
  echo "note: no reference tileset, the comparison will be skipped."
  echo "      run 'git submodule update --init data/cesium-assets' to enable it."
fi

# --user so the generated tiles belong to whoever ran this, not to root.
exec docker run --rm --init \
  --user "$(id -u):$(id -g)" \
  --volume "$PWD/.cache:/cache" \
  --volume "$OUT_DIR:/out" \
  "${REF_MOUNT[@]}" \
  "$IMAGE" "$@"
