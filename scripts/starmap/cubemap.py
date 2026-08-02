"""Build a Cesium sky box from NASA SVS Deep Star Maps 2020.

Fetches the source, reprojects it and checks its own orientation. Everything
runs here rather than being split with the shell wrapper, so a run is
reproducible from the image alone.

The source is a plate carree (equidistant cylindrical) map in ICRF/J2000, linear
light, half-float EXR, of 1.7 billion stars from Hipparcos-2, Tycho-2 and Gaia
DR2 — public domain, credit requested. https://svs.gsfc.nasa.gov/4851
Output is six 8-bit JPEG cube faces named the way `SkyBox` wants them.

Two things here are worth knowing before changing anything.

**Linear light is the whole point of the EXR.** Averaging supersamples is only
physically meaningful before the tone curve, so everything below stays linear
until `encode()` at the very end. A star that lands on one source texel keeps
its flux when it is spread across a coarser output texel; the tone curve then
decides how bright that reads. Downsampling an already tone-mapped JPEG — which
is what the Tycho asset forces — cannot do this.

**Orientation is empirical, not derived.** Between the cube map face convention,
the direction of increasing right ascension, and the `flipY` that Cesium's
`loadCubeMap` applies at upload, there are more sign conventions here than are
worth reasoning about in the dark. `--verify` scores each generated face against
the corresponding face of the Tycho asset already in the tree, over all eight
dihedral transforms, and says which one lines up. Identity everywhere means the
constants below are right.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from urllib.request import Request, urlopen

import cv2
import numpy as np

BASE_URL = "https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851"

# Cube map face directions. `u` runs left to right across the face image and `v`
# runs bottom to top, both over [-1, 1]; the third axis is the face normal. This
# is the OpenGL convention, which is what Cesium's CubeMap ultimately uploads to.
FACES: dict[str, callable] = {
    "px": lambda u, v: (np.ones_like(u), -v, -u),
    "mx": lambda u, v: (-np.ones_like(u), -v, u),
    "py": lambda u, v: (u, np.ones_like(u), v),
    "my": lambda u, v: (u, -np.ones_like(u), -v),
    "pz": lambda u, v: (u, -v, np.ones_like(u)),
    "mz": lambda u, v: (-u, -v, -np.ones_like(u)),
}

FACE_ORDER = ["px", "mx", "py", "my", "pz", "mz"]

# Per-face square symmetry applied on the way out, as an index into `dihedral`.
#
# Determined by measurement, not derivation. Between the GL face table above, the
# handedness of the celestial frame and the `flipY` Cesium applies at upload,
# there are enough conventions in play that reasoning it out is slower and less
# trustworthy than asking: `--verify` correlates each generated face against the
# Tycho asset over all eight symmetries and reports which one lands. Run it with
# this table set to identity and it prints the table to paste back here.
#
# Note the mixed parity: px/mx want a rotation, the other four want a reflection.
# A single wrong global convention would flip every face the same way, so this is
# compensating for something genuinely inconsistent between the face table and
# what Cesium uploads, not one tidy sign error. It is verified rather than
# understood — re-run `--verify` after any Cesium upgrade that touches
# `loadCubeMap` or `CubeMapPanorama`.
FACE_FIX = {"px": 2, "mx": 2, "py": 4, "my": 4, "pz": 4, "mz": 4}


def remote_size(url: str) -> int:
    req = Request(url, method="HEAD")
    with urlopen(req) as r:  # noqa: S310 — fixed https host, see BASE_URL
        return int(r.headers.get("Content-Length") or 0)


def fetch(name: str, cache_dir: str) -> str:
    """Download into the cache, resuming a partial file and skipping a whole one.

    Worth resuming rather than restarting: the 16K map is 423 MB and the cache is
    a bind mount that survives the container.
    """
    dest = os.path.join(cache_dir, name)
    url = f"{BASE_URL}/{name}"
    want = remote_size(url)
    have = os.path.getsize(dest) if os.path.exists(dest) else 0

    if want and have == want:
        print(f"cached   {name} ({have / 2**20:.0f} MB)", flush=True)
        return dest
    if have > want > 0:
        # Longer than the server's copy: truncated download from a different
        # source, or a changed file. Start over rather than append to garbage.
        have = 0

    req = Request(url)
    if have:
        req.add_header("Range", f"bytes={have}-")
        print(f"resuming {name} at {have / 2**20:.0f} of {want / 2**20:.0f} MB", flush=True)
    else:
        print(f"fetching {name} ({want / 2**20:.0f} MB)", flush=True)

    with urlopen(req) as r:  # noqa: S310
        # A server that ignores Range answers 200 with the whole body.
        append = have > 0 and r.status == 206
        done = have if append else 0
        step = max(want // 10, 1)
        next_mark = done + step
        with open(dest, "ab" if append else "wb") as f:
            while chunk := r.read(1 << 20):
                f.write(chunk)
                done += len(chunk)
                if done >= next_mark:
                    print(f"  {done / 2**20:.0f} / {want / 2**20:.0f} MB", flush=True)
                    next_mark += step

    got = os.path.getsize(dest)
    if want and got != want:
        raise SystemExit(f"{name}: expected {want} bytes, got {got}")
    return dest


def read_exr(path: str) -> np.ndarray:
    """The map as float32 BGR. OpenCV reads and writes BGR, so it round-trips."""
    img = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise SystemExit(f"could not read {path} — is OPENCV_IO_ENABLE_OPENEXR set?")
    if img.ndim == 2:
        img = np.repeat(img[:, :, None], 3, axis=2)
    return np.ascontiguousarray(img[:, :, :3].astype(np.float32))


def sample_bilinear(src: np.ndarray, sx: np.ndarray, sy: np.ndarray) -> np.ndarray:
    """Bilinear lookup that wraps in right ascension and clamps at the poles."""
    h, w = src.shape[:2]
    x0 = np.floor(sx).astype(np.int64)
    y0 = np.floor(sy).astype(np.int64)
    fx = (sx - x0).astype(np.float32)[..., None]
    fy = (sy - y0).astype(np.float32)[..., None]
    x0w, x1w = x0 % w, (x0 + 1) % w
    y0c, y1c = np.clip(y0, 0, h - 1), np.clip(y0 + 1, 0, h - 1)
    top = src[y0c, x0w] * (1.0 - fx) + src[y0c, x1w] * fx
    bot = src[y1c, x0w] * (1.0 - fx) + src[y1c, x1w] * fx
    return top * (1.0 - fy) + bot * fy


def render_face(src: np.ndarray, face: str, size: int, ss: int, block: int = 256) -> np.ndarray:
    """One face, supersampled `ss`x per axis and area-averaged back down.

    Averaging is what makes this worth doing from a 16K source: each output texel
    integrates ss^2 samples of linear radiance, so the result is a flux estimate
    rather than whichever source texel a nearest-neighbour lookup happened to hit.
    Done in row blocks purely to bound peak memory — the gathers below allocate
    proportional to the block, not the face.
    """
    h, w = src.shape[:2]
    out = np.empty((size, size, 3), np.float32)
    # Sample centres of the supersample grid, in face coordinates.
    axis = (np.arange(size * ss, dtype=np.float32) + 0.5) / (size * ss) * 2.0 - 1.0

    for y0 in range(0, size, block):
        y1 = min(y0 + block, size)
        rows = axis[y0 * ss : y1 * ss]
        uu, vv = np.meshgrid(axis, rows)
        # `v` runs bottom to top, image rows run top to bottom.
        dx, dy, dz = FACES[face](uu, -vv)
        norm = np.sqrt(dx * dx + dy * dy + dz * dz)
        dx, dy, dz = dx / norm, dy / norm, dz / norm

        ra = np.arctan2(dy, dx) % (2.0 * np.pi)
        dec = np.arcsin(np.clip(dz, -1.0, 1.0))
        # Plate carree, RA increasing to the right, +90 declination on the top
        # row. Kept in the textbook orientation on purpose: every deviation from
        # it lives in FACE_FIX instead, where it is one table rather than sign
        # flips smeared across the projection.
        sx = ra / (2.0 * np.pi) * w - 0.5
        sy = (0.5 - dec / np.pi) * h - 0.5

        block_px = sample_bilinear(src, sx, sy)
        rows_out = y1 - y0
        out[y0:y1] = block_px.reshape(rows_out, ss, size, ss, 3).mean(axis=(1, 3))

    return out


def encode(linear: np.ndarray, exposure: float) -> np.ndarray:
    """Linear radiance to 8-bit sRGB.

    Reinhard rather than a hard clip: the dynamic range between the Milky Way's
    diffuse floor and a first-magnitude star is enormous, and clipping throws away
    every distinction among the bright ones. Compressing keeps them separable and
    keeps their cores off pure white.
    """
    x = np.maximum(linear * exposure, 0.0)
    tone = x / (1.0 + x)
    srgb = np.power(tone, 1.0 / 2.2)
    return np.clip(srgb * 255.0 + 0.5, 0, 255).astype(np.uint8)


def auto_exposure(src: np.ndarray, percentile: float) -> float:
    """Scale so `percentile` of the sky's luminance lands at the tone curve's knee.

    Sampled rather than exact: a 16K map is 134 million pixels and the percentile
    of a strided quarter of them is identical to three decimals for this purpose.
    """
    lum = src[::2, ::2].max(axis=2)
    ref = float(np.percentile(lum, percentile))
    if ref <= 0.0:
        return 1.0
    return 1.0 / ref


def dihedral(img: np.ndarray, k: int) -> np.ndarray:
    """The eight square symmetries, for the orientation check."""
    out = np.rot90(img, k % 4)
    return np.fliplr(out) if k >= 4 else out


def verify(out_dir: str, ref_dir: str, prefix: str, ref_prefix: str) -> int:
    """Score each generated face against the Tycho asset already in the tree.

    Different catalogs, so the pixels never match; the *structure* does, and that
    is enough to settle orientation. Both sides are blurred hard and reduced to a
    small grid first, which throws away the star-by-star differences and leaves
    the large-scale shape of the Milky Way — then a plain correlation coefficient
    picks the transform that lines up.
    """
    worst = 1.0
    bad = 0
    suggested: dict[str, int] = {}
    print(f"{'face':6} {'applied':>8} {'best':>8} {'margin':>8}  verdict")
    for face in FACE_ORDER:
        gen_path = os.path.join(out_dir, f"{prefix}_{face}.jpg")
        ref_path = os.path.join(ref_dir, f"{ref_prefix}_{face}.jpg")
        if not (os.path.exists(gen_path) and os.path.exists(ref_path)):
            print(f"{face:6} {'-':>8} {'-':>8} {'-':>8}  missing, skipped")
            continue
        gen = cv2.imread(gen_path, cv2.IMREAD_GRAYSCALE)
        ref = cv2.imread(ref_path, cv2.IMREAD_GRAYSCALE)
        small = 96
        prep = lambda im: cv2.resize(  # noqa: E731
            cv2.GaussianBlur(im.astype(np.float32), (0, 0), im.shape[0] / 64.0),
            (small, small),
            interpolation=cv2.INTER_AREA,
        )
        g, r = prep(gen), prep(ref)
        r = (r - r.mean()) / (r.std() + 1e-6)
        scores = []
        for k in range(8):
            t = dihedral(g, k)
            t = (t - t.mean()) / (t.std() + 1e-6)
            scores.append(float((t * r).mean()))
        order = np.argsort(scores)[::-1]
        best, runner = int(order[0]), int(order[1])
        margin = scores[best] - scores[runner]
        # The correction that would have to be *composed* with what is already
        # applied, so the number below can be pasted straight into FACE_FIX.
        suggested[face] = (FACE_FIX[face] + best) % 4 if best < 4 and FACE_FIX[face] < 4 else best
        note = "ok" if best == 0 else f"needs dihedral {best}"
        if margin < 0.15:
            note += f" (weak: runner-up {runner} at {scores[runner]:.3f})"
        if best != 0:
            bad += 1
        worst = min(worst, scores[0])
        print(f"{face:6} {FACE_FIX[face]:>8} {scores[best]:8.3f} {margin:8.3f}  {note}")
    print()
    if bad:
        print(f"{bad}/6 faces need a transform. Compose it into FACE_FIX in this")
        print("file and re-run. Suggested (only valid when the current entry is 0):")
        print("  FACE_FIX = {" + ", ".join(f'"{f}": {suggested[f]}' for f in FACE_ORDER) + "}")
        return 1
    print(f"all six faces match as generated, weakest correlation {worst:.3f}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Build a Cesium sky box from NASA SVS Deep Star Maps 2020.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    ap.add_argument("--res", default="16k", choices=["8k", "16k", "32k"], help="source map resolution")
    ap.add_argument("--layers", default="full", choices=["full", "composite"],
                    help="'full' is one baked map; 'composite' adds the diffuse and bright star layers separately")
    ap.add_argument("--star-gain", type=float, default=1.0, help="scale the bright star layer, --layers composite only")
    ap.add_argument("--size", type=int, default=2048, help="cube face edge in pixels")
    ap.add_argument("--supersample", type=int, default=2, help="samples per output texel, per axis")
    ap.add_argument("--quality", type=int, default=80, help="JPEG quality")
    ap.add_argument("--exposure", default="auto", help="float, or auto")
    ap.add_argument("--exposure-percentile", type=float, default=99.99)
    ap.add_argument("--no-verify", action="store_true", help="skip the orientation check")
    # Bind mounts, set by generate.sh. Overridable for running this outside docker.
    ap.add_argument("--cache", default="/cache", help="where source EXRs are kept")
    ap.add_argument("--out", default="/out", help="where cube faces are written")
    ap.add_argument("--ref", default="/ref", help="reference faces for the orientation check")
    ap.add_argument("--prefix", default=None, help="output filename prefix")
    ap.add_argument("--verify-prefix", default="TychoSkymapII.t3_08192x04096_80")
    args = ap.parse_args()

    if args.res == "32k":
        # cv2 has no partial EXR read, so a 32K map is 6.4 GiB resident before any
        # work starts, and the reprojection needs headroom on top. Supporting it
        # means tiled reads through OpenImageIO, which is a different program.
        # 16K already oversamples a 2048px face at every point.
        raise SystemExit("32k is unsupported: 32768x16384 float32 is 6.4 GiB resident and cv2\n"
                         "cannot read EXR in tiles. 16k already oversamples a 2048px face.")

    prefix = args.prefix or f"deepstar_2020_{args.size}"
    os.makedirs(args.out, exist_ok=True)
    os.makedirs(args.cache, exist_ok=True)

    free = shutil.disk_usage(args.cache).free
    if free < 2 * 2**30:
        print(f"warning: {free / 2**30:.1f} GiB free in the cache mount", flush=True)

    if args.layers == "full":
        src = read_exr(fetch(f"starmap_2020_{args.res}.exr", args.cache))
    else:
        src = read_exr(fetch(f"milkyway_2020_{args.res}.exr", args.cache))
        stars = read_exr(fetch(f"hiptyc_2020_{args.res}.exr", args.cache))
        if stars.shape != src.shape:
            raise SystemExit(f"layer size mismatch: {src.shape} vs {stars.shape}")
        # Linear light, so the layers simply add. This is the composite the SVS
        # split exists for: the diffuse layer survives downsampling on its own
        # terms while the star layer can be weighted independently of it.
        src += stars * args.star_gain
        del stars

    h, w = src.shape[:2]
    print(f"source {w}x{h}, {src.dtype}, {src.nbytes / 2**30:.2f} GiB resident", flush=True)

    if args.exposure == "auto":
        exposure = auto_exposure(src, args.exposure_percentile)
        print(f"auto exposure {exposure:.6g} (p{args.exposure_percentile} of luminance at the knee)", flush=True)
    else:
        exposure = float(args.exposure)
        print(f"exposure {exposure:.6g}", flush=True)

    total = 0
    for face in FACE_ORDER:
        linear = render_face(src, face, args.size, args.supersample)
        pixels = dihedral(encode(linear, exposure), FACE_FIX[face])
        path = os.path.join(args.out, f"{prefix}_{face}.jpg")
        cv2.imwrite(path, np.ascontiguousarray(pixels), [cv2.IMWRITE_JPEG_QUALITY, args.quality])
        total += os.path.getsize(path)
        print(f"  {os.path.basename(path)}  {os.path.getsize(path) / 1024:.0f} KB", flush=True)
    print(f"wrote {total / 2**20:.1f} MB", flush=True)

    if args.no_verify:
        return 0
    if not os.path.isdir(args.ref):
        print("\nno reference faces mounted, skipping the orientation check", flush=True)
        return 0
    print()
    return verify(args.out, args.ref, prefix, args.verify_prefix)


if __name__ == "__main__":
    sys.exit(main())
