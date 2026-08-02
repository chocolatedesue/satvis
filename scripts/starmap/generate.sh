#!/usr/bin/env bash
# Build a Cesium sky box from NASA SVS Deep Star Maps 2020.
#
#   ./generate.sh                      16K source, 2048px faces, verified
#   ./generate.sh --res 8k --size 512  quick pass while changing tone mapping
#   ./generate.sh --layers composite   diffuse and bright stars weighted apart
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
#   .cache                  source EXRs, kept between runs
#   data/generated/starmap  the faces, picked up by vite's data/** copy
#   the Tycho asset read-only, for the orientation check
#
# Both writable mounts are committed directories carrying a .gitignore, so
# neither is created here: a bind mount whose source is missing gets created by
# docker owned by root, which is a worse failure than saying so.
set -euo pipefail

cd "${0%/*}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
IMAGE="satvis-starmap:1"
OUT_DIR="$REPO_ROOT/data/generated/starmap"
REF_DIR="$REPO_ROOT/data/cesium-assets/stars/TychoSkymapII.t3_08192x04096"

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

# The reference is optional: without the submodule the generator still runs, it
# just cannot check its own orientation.
REF_MOUNT=()
if [ -d "$REF_DIR" ]; then
  REF_MOUNT=(--volume "$REF_DIR:/ref:ro")
else
  echo "note: no Tycho reference faces, the orientation check will be skipped."
  echo "      run 'git submodule update --init data/cesium-assets' to enable it."
fi

# --user so the generated faces belong to whoever ran this, not to root.
exec docker run --rm --init \
  --user "$(id -u):$(id -g)" \
  --volume "$PWD/.cache:/cache" \
  --volume "$OUT_DIR:/out" \
  "${REF_MOUNT[@]}" \
  "$IMAGE" "$@"
