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


def exr_dims(path: str) -> tuple[int, int]:
    """(height, width) from the header, without decoding a pixel."""
    import OpenEXR

    window = OpenEXR.InputFile(path).header()["dataWindow"]
    return window.max.y - window.min.y + 1, window.max.x - window.min.x + 1


def open_source(exr_path: str) -> np.ndarray:
    """The map as a memory-mapped float16 BGR array.

    Not `cv2.imread`, because that decodes the whole image at once: the 32K map
    is 6.4 GiB as float32 and Docker's VM has a fraction of that. So the EXR is
    streamed a band of scanlines at a time into a raw sidecar beside it in the
    cache, and everything downstream reads that through a memmap — the OS pages
    in what the current block touches and evicts the rest.

    float16 is not a precision compromise: the source is half-float already, so
    the sidecar is bit-exact and half the size of the float32 it would otherwise
    take. It is kept rather than rebuilt, at the cost of disk in the cache.
    """
    import Imath
    import OpenEXR

    height, width = exr_dims(exr_path)
    raw_path = f"{exr_path.removesuffix('.exr')}.{width}x{height}.bgr16"
    want = height * width * 3 * 2

    if os.path.exists(raw_path) and os.path.getsize(raw_path) == want:
        print(f"cached   {os.path.basename(raw_path)}", flush=True)
        return np.memmap(raw_path, dtype=np.float16, mode="r", shape=(height, width, 3))

    print(f"decoding {os.path.basename(exr_path)} to {width}x{height} ({want / 2**30:.2f} GiB sidecar)", flush=True)
    src = OpenEXR.InputFile(exr_path)
    half = Imath.PixelType(Imath.PixelType.HALF)
    available = set(src.header()["channels"].keys())
    out = np.memmap(raw_path, dtype=np.float16, mode="w+", shape=(height, width, 3))
    band = 512
    # BGR on the way in, so cv2.imwrite at the other end needs no swap.
    for index, name in enumerate(("B", "G", "R")):
        channel = name if name in available else next(iter(available))
        for y0 in range(0, height, band):
            y1 = min(y0 + band, height) - 1
            buf = src.channel(channel, half, y0, y1)
            out[y0 : y1 + 1, :, index] = np.frombuffer(buf, dtype=np.float16).reshape(y1 - y0 + 1, width)
        print(f"  {name} done", flush=True)
    out.flush()
    del out
    return np.memmap(raw_path, dtype=np.float16, mode="r", shape=(height, width, 3))


def sample_bilinear(src: np.ndarray, sx: np.ndarray, sy: np.ndarray) -> np.ndarray:
    """Bilinear lookup that wraps in right ascension and clamps at the poles.

    Gathers are promoted to float32 immediately: the source is float16, and
    accumulating supersamples at that precision would quantise the faint diffuse
    background the whole exercise is about.
    """
    h, w = src.shape[:2]
    x0 = np.floor(sx).astype(np.int64)
    y0 = np.floor(sy).astype(np.int64)
    fx = (sx - x0).astype(np.float32)[..., None]
    fy = (sy - y0).astype(np.float32)[..., None]
    x0w, x1w = x0 % w, (x0 + 1) % w
    y0c, y1c = np.clip(y0, 0, h - 1), np.clip(y0 + 1, 0, h - 1)
    top = src[y0c, x0w].astype(np.float32) * (1.0 - fx) + src[y0c, x1w].astype(np.float32) * fx
    bot = src[y1c, x0w].astype(np.float32) * (1.0 - fx) + src[y1c, x1w].astype(np.float32) * fx
    return top * (1.0 - fy) + bot * fy


def render_face(layers: list[tuple[np.ndarray, float]], face: str, size: int, ss: int, block: int = 64) -> np.ndarray:
    """One face, supersampled `ss`x per axis and averaged back down.

    Each output texel integrates ss^2 samples of linear radiance, so the result is
    a flux estimate rather than whichever source texel a nearest-neighbour lookup
    happened to hit.

    **The kernel widens toward the corners, and that is the point.** A cube face
    is not uniform: a texel at the centre spans 2/N radians and one at a corner
    3^1.5 times less, so a corner texel resolves 2.3x finer detail than a middle
    one. Resample a uniform-resolution sky faithfully into that and the corners
    come out crisp while the middles come out smooth — on every face, identically,
    which tiles into a quilt with the transitions along the face boundaries. It
    reads as stitching, and a sharper source makes it worse rather than better.

    Scaling each texel's sample spread by r^1.5 — the ratio of a centre texel's
    angular size to this one's — makes every texel integrate the same solid angle,
    so the whole map is band-limited to the coarsest part of a face and the grain
    is uniform. Near an edge the widened kernel reaches into directions belonging
    to the neighbouring face, which is exactly what makes the two agree there.

    Layers are summed here rather than up front so `--layers composite` never
    materialises a combined map. At 32K that array would be larger than the VM.

    Row blocks bound peak memory, and with a memmapped source they also bound the
    working set: one block touches a band of source rows, not the whole file.
    """
    h, w = layers[0][0].shape[:2]
    out = np.empty((size, size, 3), np.float32)
    centres = (np.arange(size, dtype=np.float32) + 0.5) / size * 2.0 - 1.0
    offsets = ((np.arange(ss, dtype=np.float32) + 0.5) / ss - 0.5) * (2.0 / size)

    for y0 in range(0, size, block):
        y1 = min(y0 + block, size)
        uc, vc = centres, centres[y0:y1]
        spread = (np.sqrt(1.0 + uc[None, :] ** 2 + vc[:, None] ** 2) ** 1.5)[:, None, :, None]
        uu = uc[None, None, :, None] + offsets[None, None, None, :] * spread
        vv = vc[:, None, None, None] + offsets[None, :, None, None] * spread
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

        block_px = None
        for array, gain in layers:
            contribution = sample_bilinear(array, sx, sy)
            if gain != 1.0:
                contribution *= gain
            block_px = contribution if block_px is None else block_px + contribution
        # (rows, ss, size, ss, 3) from the broadcast above; average the two
        # sub-texel axes away.
        out[y0:y1] = block_px.mean(axis=(1, 3))

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


def auto_exposure(layers: list[tuple[np.ndarray, float]], percentile: float) -> float:
    """Scale so `percentile` of the sky's luminance lands at the tone curve's knee.

    Read on a stride and band by band. Taking `src[::8, ::8]` of a memmap in one
    go would fault in the entire file, which at 32K is larger than the machine
    this runs on; the percentile of every 64th pixel is identical to three
    decimals for this purpose anyway.
    """
    h = layers[0][0].shape[0]
    samples = []
    for y0 in range(0, h, 1024):
        y1 = min(y0 + 1024, h)
        band = None
        for array, gain in layers:
            part = array[y0:y1:8, ::8].astype(np.float32)
            if gain != 1.0:
                part *= gain
            band = part if band is None else band + part
        samples.append(band.max(axis=2).ravel())
    ref = float(np.percentile(np.concatenate(samples), percentile))
    return 1.0 if ref <= 0.0 else 1.0 / ref


def face_centre_px_per_deg(size: int) -> float:
    """Angular resolution at the middle of a face, the coarsest point on it.

    A texel there spans 2/N radians; at a corner it is 3^1.5 times finer. For a
    2048px face that is 17.9 px/deg against 40.8.
    """
    return size * np.pi / 360.0


def default_supersample(size: int, width: int) -> int:
    """Enough samples per texel that the coarsest part of a face still filters.

    The centre of a face is where the source is minified hardest, and a fixed 2x2
    grid there is four point samples spread over several source texels — while at
    the corners, where the face is 2.3x finer, those same four samples sit inside
    one source texel and no filtering happens at all. That difference in grain is
    uniform across every face, so it tiles: soft middles, crisp edges, and a
    quilted look with the transitions along the face boundaries.

    Matching the sample count to the centre's minification makes the integration
    real where it is needed, which is what the 32K source is for.
    """
    ratio = (width / 360.0) / face_centre_px_per_deg(size)
    # Capped at 4: cost is quadratic in this, and 16 samples already turns the
    # corners from "no filtering at all" into a real average, which is the part
    # that was showing as seams. Override with --supersample for more.
    return int(min(4, max(2, np.ceil(ratio))))


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
    ap.add_argument("--supersample", default="auto", help="samples per output texel per axis, or auto from the source resolution")
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

    prefix = args.prefix or f"deepstar_2020_{args.size}"
    os.makedirs(args.out, exist_ok=True)
    os.makedirs(args.cache, exist_ok=True)

    free = shutil.disk_usage(args.cache).free
    if free < 2 * 2**30:
        print(f"warning: {free / 2**30:.1f} GiB free in the cache mount", flush=True)

    if args.layers == "full":
        # Linear light, so layers simply add — kept separate rather than summed
        # here so the composite path never materialises a combined map.
        layers = [(open_source(fetch(f"starmap_2020_{args.res}.exr", args.cache)), 1.0)]
    else:
        layers = [
            (open_source(fetch(f"milkyway_2020_{args.res}.exr", args.cache)), 1.0),
            (open_source(fetch(f"hiptyc_2020_{args.res}.exr", args.cache)), args.star_gain),
        ]
        if layers[0][0].shape != layers[1][0].shape:
            raise SystemExit(f"layer size mismatch: {layers[0][0].shape} vs {layers[1][0].shape}")

    h, w = layers[0][0].shape[:2]
    ss = default_supersample(args.size, w) if args.supersample == "auto" else int(args.supersample)
    print(f"source {w}x{h} float16, {ss}x{ss} samples per texel", flush=True)

    if args.exposure == "auto":
        exposure = auto_exposure(layers, args.exposure_percentile)
        print(f"auto exposure {exposure:.6g} (p{args.exposure_percentile} of luminance at the knee)", flush=True)
    else:
        exposure = float(args.exposure)
        print(f"exposure {exposure:.6g}", flush=True)

    total = 0
    for face in FACE_ORDER:
        linear = render_face(layers, face, args.size, ss)
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
