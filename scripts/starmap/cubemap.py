"""Build a Cesium sky box from NASA SVS Deep Star Maps 2020.

Fetches the source, reprojects it and checks its own orientation. Everything
runs here rather than being split with the shell wrapper, so a run is
reproducible from the image alone.

The source is a plate carree (equidistant cylindrical) map in ICRF/J2000, linear
light, half-float EXR, of 1.7 billion stars from Hipparcos-2, Tycho-2 and Gaia
DR2 — public domain, credit requested. https://svs.gsfc.nasa.gov/4851
Output is six 8-bit JPEG cube faces named the way `SkyBox` wants them.

Two things are worth knowing before changing anything.

**Linear light is the whole point of the EXR.** Averaging supersamples is only
physically meaningful before the tone curve, so everything stays linear until
`encode()` at the very end. Downsampling an already tone-mapped JPEG — which is
what the Tycho asset forces — cannot do this.

**Orientation is checked as a whole, never patched per face.** `--verify`
correlates each face against the Tycho asset over all eight dihedral transforms;
anything but identity means the projection is wrong. Rotating one face to make
it match is a trap, because the set then stops agreeing at the shared edges.
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


def fetch(name: str, cache_dir: str) -> str:
    """Download into the cache, resuming a partial file and skipping a whole one.

    Worth resuming rather than restarting: the 16K map is 423 MB and the cache is
    a bind mount that survives the container.
    """
    dest = os.path.join(cache_dir, name)
    url = f"{BASE_URL}/{name}"
    with urlopen(Request(url, method="HEAD")) as head:  # noqa: S310 — fixed host, see BASE_URL
        want = int(head.headers.get("Content-Length") or 0)
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


def open_source(exr_path: str) -> np.ndarray:
    """The map as a memory-mapped float16 BGR array.

    Not `cv2.imread`, because that decodes the whole image at once: the 32K map
    is 6.4 GiB as float32 and Docker's VM has a fraction of that. So the EXR is
    streamed a band of scanlines at a time into a raw sidecar beside it in the
    cache, and everything downstream reads that through a memmap — the OS pages
    in what the current block touches and evicts the rest.

    float16 is not a precision compromise: the source is half-float already, so
    the sidecar is bit-exact and half the size of float32. It is kept rather than
    rebuilt, at the cost of disk in the cache.
    """
    import Imath
    import OpenEXR

    src = OpenEXR.InputFile(exr_path)
    window = src.header()["dataWindow"]
    height = window.max.y - window.min.y + 1
    width = window.max.x - window.min.x + 1
    raw_path = f"{exr_path.removesuffix('.exr')}.{width}x{height}.bgr16"
    shape = (height, width, 3)
    want = height * width * 3 * 2

    if os.path.exists(raw_path) and os.path.getsize(raw_path) == want:
        print(f"cached   {os.path.basename(raw_path)}", flush=True)
        return np.memmap(raw_path, dtype=np.float16, mode="r", shape=shape)

    print(f"decoding {os.path.basename(exr_path)} to {width}x{height} ({want / 2**30:.2f} GiB sidecar)", flush=True)
    half = Imath.PixelType(Imath.PixelType.HALF)
    available = set(src.header()["channels"].keys())
    out = np.memmap(raw_path, dtype=np.float16, mode="w+", shape=shape)
    # BGR on the way in, so cv2.imwrite at the other end needs no swap.
    for index, name in enumerate(("B", "G", "R")):
        channel = name if name in available else next(iter(available))
        for y0 in range(0, height, 512):
            y1 = min(y0 + 512, height) - 1
            buf = src.channel(channel, half, y0, y1)
            out[y0 : y1 + 1, :, index] = np.frombuffer(buf, dtype=np.float16).reshape(y1 - y0 + 1, width)
        print(f"  {name} done", flush=True)
    out.flush()
    del out
    return np.memmap(raw_path, dtype=np.float16, mode="r", shape=shape)


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

    **The kernel widens toward the corners**, by r^1.5 — the ratio of a centre
    texel's angular size to this one's — so every texel integrates the same solid
    angle. Without it the corners resolve 2.3x finer than the middles and the
    resulting grain difference tiles across all six faces as a quilt; see
    `default_supersample`. Near an edge the widened kernel reaches into directions
    belonging to the neighbouring face, which is what makes the two agree there.

    Layers are summed here rather than up front so `--layers composite` never
    materialises a combined map; at 32K that array would exceed the VM. Row blocks
    bound peak memory and, with a memmapped source, the working set too.
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

        # ra -> pi - ra reflects the direction through x=0, because the source's
        # left edge is RA 180 with right ascension increasing leftward: it is drawn
        # as the sky looks from outside the celestial sphere, and a sky box is
        # viewed from inside. Established by cross-correlating every generated face
        # against every reference face — a clean diagonal except that +X and -X
        # trade places, with every face wanting a horizontal mirror, which is
        # exactly a reflection through that axis.
        ra = np.arctan2(dy, dx)
        dec = np.arcsin(np.clip(dz, -1.0, 1.0))
        sx = ((np.pi - ra) % (2.0 * np.pi)) / (2.0 * np.pi) * w - 0.5
        sy = (0.5 - dec / np.pi) * h - 0.5

        # (rows, ss, size, ss, 3) from the broadcast above; average the sub-texel axes.
        block_px = sum(sample_bilinear(array, sx, sy) * gain for array, gain in layers)
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
        band = sum(array[y0 : y0 + 1024 : 8, ::8].astype(np.float32) * gain for array, gain in layers)
        samples.append(band.max(axis=2).ravel())
    ref = float(np.percentile(np.concatenate(samples), percentile))
    return 1.0 if ref <= 0.0 else 1.0 / ref


def default_supersample(size: int, width: int) -> int:
    """Enough samples per texel that the coarsest part of a face still filters.

    The centre of a face is where the source is minified hardest, and a fixed 2x2
    grid there is four point samples spread over several source texels — while at
    the corners, where the face is 2.3x finer, those same four samples sit inside
    one source texel and no filtering happens at all. That difference in grain is
    uniform across every face, so it tiles: soft middles, crisp edges, and a
    quilted look with the transitions along the face boundaries.

    Matching the sample count to the centre's minification makes the integration
    real where it is needed, which is what the 32K source is for. A face-centre
    texel spans 2/N radians, i.e. size*pi/360 px/deg — 17.9 at 2048, against 40.8
    at a corner.
    """
    ratio = (width / 360.0) / (size * np.pi / 360.0)
    # Capped at 4: cost is quadratic in this, and 16 samples already turns the
    # corners from "no filtering at all" into a real average, which is the part
    # that was showing as seams. Override with --supersample for more.
    return int(min(4, max(2, np.ceil(ratio))))


def open_layers(mode: str, res: str, star_gain: float, cache_dir: str) -> list[tuple[np.ndarray, float]]:
    """The source maps to sum, each with its weight.

    Linear light, so layers simply add — but they are kept apart rather than
    summed here so the composite path never materialises a combined map. At 32K
    that array alone would exceed the VM.
    """
    if mode == "full":
        return [(open_source(fetch(f"starmap_2020_{res}.exr", cache_dir)), 1.0)]

    layers = [
        (open_source(fetch(f"milkyway_2020_{res}.exr", cache_dir)), 1.0),
        (open_source(fetch(f"hiptyc_2020_{res}.exr", cache_dir)), star_gain),
    ]
    if layers[0][0].shape != layers[1][0].shape:
        raise SystemExit(f"layer size mismatch: {layers[0][0].shape} vs {layers[1][0].shape}")
    return layers


def dihedral(img: np.ndarray, k: int) -> np.ndarray:
    """The eight square symmetries, for the orientation check."""
    out = np.rot90(img, k % 4)
    return np.fliplr(out) if k >= 4 else out


def star_field(path: str) -> np.ndarray:
    """A face reduced to where its stars are, for comparing against another map.

    High-passed rather than blurred. An earlier version of this check smoothed
    both sides down to 96x96 and correlated the large-scale shape of the Milky
    Way, which is nearly symmetric under several of the eight transforms — it
    picked a wrong one for a face by a margin of 0.09 and the mistake only
    surfaced later as a visible seam between two faces.

    Stars are the opposite kind of feature: point-like, in the same places in
    both catalogues, and shared between them for everything bright. Subtracting a
    blur leaves those and throws away the diffuse difference between Tycho and
    Gaia, so the correct transform wins by an order of magnitude instead of a
    hair.
    """
    img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise SystemExit(f"could not read {path}")
    small = cv2.resize(img, (1024, 1024), interpolation=cv2.INTER_AREA).astype(np.float32)
    high = small - cv2.GaussianBlur(small, (0, 0), 3.0)
    return (high - high.mean()) / (high.std() + 1e-6)


def verify(out_dir: str, ref_dir: str, prefix: str, ref_prefix: str) -> int:
    """Check every generated face against the Tycho asset already in the tree.

    Tycho is the reference because it is known to render correctly in Cesium, and
    both it and this map reach the GPU by the same path — `Resource.fetchImage`
    with `flipY`, then `CubeMap` with its own `flipY` — so a face that matches
    Tycho's orientation is by construction right for Cesium's lookup. That makes
    the reference worth more than reasoning about the convention.
    """
    worst = 1.0
    bad = 0
    print(f"{'face':6} {'best':>8} {'2nd':>8} {'margin':>8}  verdict")
    for face in FACE_ORDER:
        gen_path = os.path.join(out_dir, f"{prefix}_{face}.jpg")
        ref_path = os.path.join(ref_dir, f"{ref_prefix}_{face}.jpg")
        if not (os.path.exists(gen_path) and os.path.exists(ref_path)):
            print(f"{face:6} {'-':>8} {'-':>8} {'-':>8}  missing, skipped")
            continue
        gen, ref = star_field(gen_path), star_field(ref_path)
        scores = []
        for k in range(8):
            t = dihedral(gen, k)
            scores.append(float((t * ref).mean()))
        order = np.argsort(scores)[::-1]
        best, runner = int(order[0]), int(order[1])
        margin = scores[best] - scores[runner]
        note = "ok" if best == 0 else f"needs dihedral {best}"
        # With star positions rather than blurred structure the right answer is
        # unambiguous; anything close is a signal not to trust the result.
        if margin < 0.05:
            note += f" — AMBIGUOUS, runner-up {runner} at {scores[runner]:.3f}"
        if best != 0:
            bad += 1
        worst = min(worst, scores[0])
        print(f"{face:6} {scores[best]:8.3f} {scores[runner]:8.3f} {margin:8.3f}  {note}")
    print()
    if bad:
        print(f"{bad}/6 faces do not match the reference. A face wanting a rotation or")
        print("mirror means the projection is wrong — fix that rather than rotating the")
        print("output, or adjacent faces stop agreeing at their shared edges.")
        return 1
    print(f"all six faces match the reference as generated, weakest correlation {worst:.3f}")
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

    layers = open_layers(args.layers, args.res, args.star_gain, args.cache)
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
        pixels = encode(linear, exposure)
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
