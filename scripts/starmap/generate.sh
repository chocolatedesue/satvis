#!/usr/bin/env bash
# Build a Cesium sky box from NASA SVS Deep Star Maps 2020.
#
#   ./generate.sh                      16K source, 2048px and 1024px cuts, verified
#   ./generate.sh --size 2048          just the one cut
#   ./generate.sh --res 32k            the sharpest source, ~1.5 GB to fetch once
#   ./generate.sh --res 8k --size 512  quick pass while changing tone mapping
#   ./generate.sh --match-edges 0      leave the face boundaries unreconciled
#   ./generate.sh --help               everything else
#
# This file only builds the image and starts the container. Downloading, the
# reprojection and the orientation check all live in cubemap.py so that a run is
# reproducible from the image alone and the host needs nothing but docker.
#
# The generator lives here rather than beside its output because vite copies
# data/** into the build wholesale: anything kept there ships to production, so
# data/ holds the six faces and nothing else. The source EXRs stay under this
# directory for the same reason — hundreds of megabytes that must never be
# mistaken for shippable data.
#
# Three bind mounts:
#   .cache        source EXRs, kept between runs
#   data/starmap  the faces, picked up by vite's data/** copy
#   the Tycho asset read-only, for the orientation check
#
# Both writable mounts are committed directories carrying a .gitignore, so
# neither is created here: a bind mount whose source is missing gets created by
# docker owned by root, which is a worse failure than saying so.
set -euo pipefail

cd "${0%/*}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
IMAGE="satvis-starmap:1"
OUT_DIR="$REPO_ROOT/data/starmap"
REF_DIR="$REPO_ROOT/scripts/.reference/cesium-assets/stars/TychoSkymapII.t3_08192x04096"

if ! docker info >/dev/null 2>&1; then
  echo "docker is not running — this script keeps numpy and the EXR reader off" >&2
  echo "the host by doing all the work in a container." >&2
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

# The reference is optional, and does not affect a single output byte: the faces are
# written first and read back for the check. It was a submodule everybody had to
# initialise; it is an on-demand clone now.
REF_MOUNT=()
if [ -d "$REF_DIR" ]; then
  REF_MOUNT=(--volume "$REF_DIR:/ref:ro")
else
  echo "note: no Tycho reference faces, the orientation check will be skipped. To enable it:"
  echo "      git clone --depth 1 https://github.com/Flowm/cesium-assets scripts/.reference/cesium-assets"
fi

# --user so the generated faces belong to whoever ran this, not to root.
exec docker run --rm --init \
  --user "$(id -u):$(id -g)" \
  --volume "$PWD/.cache:/cache" \
  --volume "$OUT_DIR:/out" \
  "${REF_MOUNT[@]}" \
  "$IMAGE" "$@"
