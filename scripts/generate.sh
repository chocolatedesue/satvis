#!/usr/bin/env bash
# Run one of the containerised asset generators.
#
#   pnpm update-imagery          the offline base map      (scripts/imagery)
#   pnpm update-starmap          the sky box faces         (scripts/starmap)
#
# Anything after the target is passed through to the generator, so
# `pnpm update-starmap --res 32k` and `pnpm update-imagery --help` do what they
# look like. Each generator documents its own flags in its argparse; this file
# knows nothing about them.
#
# One script rather than one per generator because they had drifted into 26
# identical lines out of 32, differing only in an image tag, two paths and a
# noun. They are *run* separately and deliberately so: the base map's shallow
# levels are committed and its source is checksum-pinned, so it is regenerated
# about never and always ends in a commit, while the sky box is an opt-in asset
# somebody builds when they want it. Chaining them would make each pay the
# other's download — 734 MB between them — for no case that wants both.
#
# What every generator here has in common, and all this file does:
#
#   - the toolchain stays in the container, so the host needs nothing but docker
#   - the source downloads live in the generator's own .cache, never under data/,
#     because vite copies data/** into the build wholesale and those are hundreds
#     of megabytes that must not be mistaken for shippable data
#   - output goes to a committed directory carrying a .gitignore, so a bind mount
#     never has to be created here — docker would create a missing one owned by
#     root, which is a worse failure than saying so
#   - the reference assets are optional and read-only, and never affect a single
#     output byte: every generator writes its output first and reads the reference
#     back to check it
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
TARGET="${1-}"
shift || true

case "$TARGET" in
  imagery)
    IMAGE="satvis-imagery:1"
    OUT_DIR="$REPO_ROOT/data/imagery"
    REF_DIR="$REPO_ROOT/scripts/.reference/cesium-assets/imagery/NaturalEarthII"
    REF_SKIPS="the colour comparison against the tileset it replaces"
    ;;
  starmap)
    IMAGE="satvis-starmap:1"
    OUT_DIR="$REPO_ROOT/data/starmap"
    REF_DIR="$REPO_ROOT/scripts/.reference/cesium-assets/stars/TychoSkymapII.t3_08192x04096"
    REF_SKIPS="the orientation check against the Tycho faces"
    ;;
  *)
    echo "usage: ${0##*/} <imagery|starmap> [generator options...]" >&2
    echo "       normally reached as \`pnpm update-imagery\` or \`pnpm update-starmap\`." >&2
    exit 2
    ;;
esac

CONTEXT="$REPO_ROOT/scripts/$TARGET"
CACHE_DIR="$CONTEXT/.cache"

if ! docker info >/dev/null 2>&1; then
  echo "docker is not running — these generators keep their toolchains off the host" >&2
  echo "by doing all the work in a container." >&2
  exit 1
fi

for dir in "$CACHE_DIR" "$OUT_DIR"; do
  [ -d "$dir" ] && continue
  echo "missing tracked directory: ${dir#"$REPO_ROOT"/}" >&2
  echo "it is committed with a .gitignore inside; restore it with git checkout." >&2
  exit 1
done

echo "building $IMAGE"
docker build --quiet --tag "$IMAGE" "$CONTEXT" >/dev/null

# Mounted when it happens to be there. It used to be a submodule everybody had to
# initialise for a check most people never run; it is an on-demand clone now.
REF_MOUNT=()
if [ -d "$REF_DIR" ]; then
  REF_MOUNT=(--volume "$REF_DIR:/ref:ro")
else
  echo "note: no reference assets, so $REF_SKIPS will be skipped. To enable it:"
  echo "      git clone --depth 1 https://github.com/Flowm/cesium-assets scripts/.reference/cesium-assets"
fi

# --user so the generated files belong to whoever ran this, not to root.
exec docker run --rm --init \
  --user "$(id -u):$(id -g)" \
  --volume "$CACHE_DIR:/cache" \
  --volume "$OUT_DIR:/out" \
  "${REF_MOUNT[@]}" \
  "$IMAGE" "$@"
