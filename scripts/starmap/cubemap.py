"""Build a Cesium sky box from NASA SVS Deep Star Maps 2020.

Fetches the source, reprojects it and checks its own orientation. Everything
runs here rather than being split with the shell wrapper, so a run is
reproducible from the image alone.

The source is a plate carree (equidistant cylindrical) map in ICRF/J2000, linear
light, half-float EXR, of 1.7 billion stars from Hipparcos-2, Tycho-2 and Gaia
DR2 — public domain, credit requested. https://svs.gsfc.nasa.gov/4851
Output is six 8-bit WebP cube faces named the way `SkyBox` wants them (see
`FORMAT` for why WebP and not JPEG).

Three things are worth knowing before changing anything.

**Linear light is the whole point of the EXR.** Averaging supersamples is only
physically meaningful before the tone curve, so everything stays linear until
`encode()` at the very end. Downsampling an already tone-mapped JPEG — which is
what the Tycho asset forces — cannot do this.

**Orientation is checked as a whole, never patched per face.** The check (on by
default, `--no-verify` to skip) correlates each face against the Tycho asset over
all eight dihedral transforms; anything but identity means the projection is
wrong. Rotating one face to make it match is a trap, because the set then stops
agreeing at the shared edges.

**A correct projection still leaves a step at the edges**, and `--match-edges`
is what removes it. Six square grids cannot tile a sphere evenly: adjacent border
texels are mirror images about their shared edge and integrate differently skewed
patches of sky, which differs systematically along the whole edge. Measured on
the 32K source at 2048px, that is a coherent 0.90 levels on average and 5.67 at
worst, against ~1.0 levels of coherent grain — a faint but real line. It shrinks
with supersampling (2.19 -> 1.30 coherent at 512px going from 1 to 4 samples per
axis) and does not go away, because it is sampling, not a bug.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from collections.abc import Callable
from typing import NamedTuple
from urllib.request import Request, urlopen

import cv2
import numpy as np

BASE_URL = "https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851"

# Cube map face directions. `u` runs left to right across the face image and `v`
# runs bottom to top, both over [-1, 1]; the third axis is the face normal. This
# is the OpenGL convention, which is what Cesium's CubeMap ultimately uploads to.
FACES: dict[str, Callable[[np.ndarray, np.ndarray], tuple[np.ndarray, np.ndarray, np.ndarray]]] = {
    "px": lambda u, v: (np.ones_like(u), -v, -u),
    "mx": lambda u, v: (-np.ones_like(u), -v, u),
    "py": lambda u, v: (u, np.ones_like(u), v),
    "my": lambda u, v: (u, -np.ones_like(u), -v),
    "pz": lambda u, v: (u, -v, np.ones_like(u)),
    "mz": lambda u, v: (-u, -v, -np.ones_like(u)),
}

FACE_ORDER = ["px", "mx", "py", "my", "pz", "mz"]

# Where auto exposure puts the tone curve's knee. High enough that only genuine
# stars sit above it, low enough that the Milky Way is not crushed against it.
EXPOSURE_PERCENTILE = 99.99

# WebP, because this content is close to JPEG's worst case and WebP beats it at
# every point on the curve — about half the bytes at equal error, or clearly less
# error at equal bytes.
#
# The reason is what the histogram says: a face here occupies 200 of 256 levels
# but its *median* is 13, so nearly everything of interest sits in the bottom 6%
# of the range, and stars are isolated bright points on that near-black ground.
# JPEG answers with 8x8 DCT blocking in the darks and ringing haloes around the
# stars. Measured against `encode()`'s own output on two 2048px faces, mean
# absolute error per texel:
#
#                        KB   mean   dark  stars
#   jpeg q80 4:2:0      495   2.78   2.32   7.61   <- what this used to write
#   jpeg q92 4:4:4     1012   2.19   1.90   4.25
#   webp q90            676   2.17   1.86   5.13
#   webp q95           1121   1.68   1.43   3.79   <- now
#   avif q90           1034   1.66   1.27   4.51
#   webp lossless      4045   0      0      0
#
# An error of 2.3 against a median of 13 is about 18% of the signal, which is why
# q80 JPEG mottled the sky. q95 is chosen rather than lossless because it is
# where codec error stops dominating: 1.4 levels is close enough to the 1-level
# quantisation floor of 8-bit that the next real gain would need more bit depth,
# not a better codec, and lossless costs 4x the bytes to buy 1.4 levels.
#
# AVIF scores marginally better in the darks and worse on stars, for a slower
# decode and a narrower floor of browser support. Not worth it for six textures
# that are fetched once and cached.
#
# Declared as a pair, because cv2 picks its encoder from the file extension while
# the quality parameter is named after a specific one. Changing the suffix alone
# would write a different format and quietly hand it WebP's quality flag, which
# it ignores — a wrong file with no error.
FORMAT = "webp"
QUALITY_FLAG = cv2.IMWRITE_WEBP_QUALITY


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


def render_face(src: np.ndarray, face: str, size: int, ss: int, block: int = 64) -> np.ndarray:
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

    Row blocks bound peak memory and, with a memmapped source, the working set
    too: one block touches a band of source rows, not the whole file.
    """
    h, w = src.shape[:2]
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
        out[y0:y1] = sample_bilinear(src, sx, sy).mean(axis=(1, 3))

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


def auto_exposure(src: np.ndarray, percentile: float = EXPOSURE_PERCENTILE) -> float:
    """Scale so `percentile` of the sky's luminance lands at the tone curve's knee.

    Read on a stride and band by band. Taking `src[::8, ::8]` of a memmap in one
    go would fault in the entire file, which at 32K is larger than the machine
    this runs on; the percentile of every 64th pixel is identical to three
    decimals for this purpose anyway.
    """
    samples = [src[y0 : y0 + 1024 : 8, ::8].astype(np.float32).max(axis=2).ravel() for y0 in range(0, src.shape[0], 1024)]
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


def face_basis(face: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(normal, du, dv) as signed unit axes, read out of `FACES` itself.

    Every entry there is a signed axis permutation, so evaluating it at three
    points recovers the frame exactly — no second copy of the convention to keep
    in step with the first.
    """

    def sample(u: float, v: float) -> np.ndarray:
        components = FACES[face](np.full(1, u), np.full(1, v))
        return np.array([float(np.asarray(c).item()) for c in components])

    normal = sample(0.0, 0.0)
    return normal, sample(1.0, 0.0) - normal, sample(0.0, 1.0) - normal


# Read once: `edge_pairs` needs every face's frame against every other's, which
# is 24 sides x 7 lookups if it asks each time.
BASES: dict[str, tuple[np.ndarray, np.ndarray, np.ndarray]] = {face: face_basis(face) for face in FACE_ORDER}


class Border(NamedTuple):
    """One face's row of border texels along a shared edge, as (rows, cols) indices.

    The three travel together everywhere they go, and a pair of them is what an
    edge is, so they are one thing rather than a triple that every consumer has
    to destructure in the right order.
    """

    face: str
    rows: np.ndarray
    cols: np.ndarray


def edge_pairs(size: int) -> list[tuple[Border, Border]]:
    """For each of the 12 shared edges, the two rows of border texels that meet on it.

    Derived rather than tabulated. Each side of a face is walked at its exact
    boundary (the coordinate pinned to +-1, the tangential one at texel centres);
    that direction names the neighbour by major axis, and re-expressing it in the
    neighbour's frame says which of its border texels lies opposite. Rounding is
    exact to well under a texel — asserted below — because the two faces' border
    texels are mirror images about the edge, both one half-texel inside it.
    """
    idx = np.arange(size)
    centres = (idx + 0.5) * 2.0 / size - 1.0
    ones = np.ones(size)
    inner = 1.0 - 1.0 / size  # where a border texel's own centre sits

    # Each side's name, its (u, v) along the boundary, and the pixels those belong
    # to. v runs bottom to top while rows run top to bottom, hence -centres for the
    # vertical sides. The name is carried only so a failed assertion can say which
    # side it was; nothing downstream keys off it.
    sides = (
        ("top", centres, ones, np.zeros(size, int), idx),
        ("bottom", centres, -ones, np.full(size, size - 1), idx),
        ("left", -ones, -centres, idx, np.zeros(size, int)),
        ("right", ones, -centres, idx, np.full(size, size - 1)),
    )

    seen: set[frozenset] = set()
    pairs = []
    for face, (side, u, v, rows, cols) in ((f, s) for f in FACE_ORDER for s in sides):
        normal, du, dv = BASES[face]
        edge = normal[:, None] + du[:, None] * u + dv[:, None] * v

        # The neighbour is whichever face this boundary direction points into.
        others = [f for f in FACE_ORDER if f != face]
        far = max(others, key=lambda f: BASES[f][0] @ edge[:, 0])
        nb_normal, nb_du, nb_dv = BASES[far]

        nu = (nb_du @ edge) / (nb_normal @ edge)
        nv = (nb_dv @ edge) / (nb_normal @ edge)
        # One of the two is pinned to +-1 on the shared edge; step it half a texel
        # in to reach the neighbour's own border texel and leave the other alone.
        pinned = np.abs(np.abs(nu) - 1.0) < np.abs(np.abs(nv) - 1.0)
        nu = np.where(pinned, np.sign(nu) * inner, nu)
        nv = np.where(pinned, nv, np.sign(nv) * inner)

        nx = (nu + 1.0) * size / 2.0 - 0.5
        ny = (1.0 - nv) * size / 2.0 - 0.5
        drift = max(np.abs(nx - np.round(nx)).max(), np.abs(ny - np.round(ny)).max())
        if drift > 1e-6:
            raise AssertionError(f"{face} {side} border does not land on {far} texels (off by {drift:.3g})")

        key = frozenset((face, far))
        if key not in seen:
            seen.add(key)
            here = Border(face, rows, cols)
            there = Border(far, np.round(ny).astype(int), np.round(nx).astype(int))
            pairs.append((here, there))

    if len(pairs) != 12:
        raise AssertionError(f"expected 12 shared edges, derived {len(pairs)}")
    return pairs


SIDES = ("top", "bottom", "left", "right")


def sides_of(y: int, x: int, size: int) -> list[tuple[str, int]]:
    """Which side a border texel sits on, and where along it — two entries at a corner."""
    on = []
    if y == 0:
        on.append(("top", x))
    if y == size - 1:
        on.append(("bottom", x))
    if x == 0:
        on.append(("left", y))
    if x == size - 1:
        on.append(("right", y))
    return on


def edge_step(faces: dict[str, np.ndarray], pairs: list[tuple[Border, Border]], exposure: float) -> tuple[float, float]:
    """Mean and p99 brightness difference across the shared edges, in 8-bit levels.

    Measured after `encode`, because the tone curve is steep where this map is
    dark: a difference the eye can see in the sky is far below one 8-bit level in
    linear radiance, and a linear metric reports it as nothing.
    """
    diffs = []
    for here, there in pairs:
        a = encode(faces[here.face][here.rows, here.cols], exposure).astype(np.float32)
        b = encode(faces[there.face][there.rows, there.cols], exposure).astype(np.float32)
        diffs.append(np.abs(a - b).max(axis=1))
    joined = np.concatenate(diffs)
    return float(joined.mean()), float(np.percentile(joined, 99))


def match_edges(faces: dict[str, np.ndarray], pairs: list[tuple[Border, Border]], feather: int) -> None:
    """Reconcile the faces across their shared edges, in place and in linear light.

    Two texels meet along an edge and three at each corner; every such group is
    set to its own mean. That is the standard cube map seam fixup, and on its own
    it is a one-texel-wide change that trades a step for a thinner step.

    The feather is what makes it a fix rather than a smear: the correction each
    border texel needs is carried `feather` texels inward on a linear ramp, so the
    two faces converge over a band instead of jumping at the last row.

    Linear light, before the tone curve, for the same reason supersampling is:
    averaging radiance is meaningful, averaging sRGB is not.

    Four texels is the measured optimum at 2048px, by sweeping 2 to 64 and scoring
    the correction the fixup itself introduces. Below it the ramp is steep enough
    to read as a second, softer line; above it the correction grows — the same
    linear delta carried further inward lands on more of the tone curve, so by 64
    it is a 12 level smear where at 4 it is 4. The residual step at 4 is 0.17
    levels at worst, against the 5.67 it started from.
    """
    size = next(iter(faces.values())).shape[0]
    # Below 1 the ramp divides by zero; at size/2 opposite ramps meet in the
    # middle and the interpolation below stops reproducing its own boundary.
    if not 1 <= feather < size // 2:
        raise SystemExit(f"--match-edges must be between 1 and {size // 2 - 1} for {size}px faces, got {feather}")

    # Group the border texels that must agree — pairs along edges, triples at the
    # corners, found by union rather than special-cased.
    Texel = tuple[str, int, int]
    parent: dict[Texel, Texel] = {}

    def find(k: Texel) -> Texel:
        parent.setdefault(k, k)
        while parent[k] != k:
            parent[k] = parent[parent[k]]
            k = parent[k]
        return k

    for here, there in pairs:
        for i in range(len(here.rows)):
            ka = find((here.face, int(here.rows[i]), int(here.cols[i])))
            kb = find((there.face, int(there.rows[i]), int(there.cols[i])))
            if ka != kb:
                parent[ka] = kb

    groups: dict[Texel, list[Texel]] = {}
    for key in list(parent):
        groups.setdefault(find(key), []).append(key)

    # Corrections are held per side rather than as six full-size images: they are
    # four texels wide out of 2048 and the zeros would cost 300 MB.
    deltas = {face: {side: np.zeros((size, 3), np.float32) for side in SIDES} for face in faces}
    for members in groups.values():
        mean = np.mean([faces[f][y, x] for f, y, x in members], axis=0)
        for f, y, x in members:
            for side, along in sides_of(y, x, size):
                deltas[f][side][along] = mean - faces[f][y, x]

    ramp = np.clip(1.0 - np.arange(size, dtype=np.float32) / feather, 0.0, 1.0)
    wt, wb = ramp[:, None], ramp[::-1, None]  # by row, from the top and bottom
    wl, wr = ramp[None, :], ramp[None, ::-1]  # by column, from the left and right
    for face, delta in deltas.items():
        top, bottom, left, right = (delta[side] for side in SIDES)
        # Transfinite (Coons) interpolation, and the third term is the whole
        # point of it. Near a corner the vertical and horizontal ramps both reach
        # the same texel and both carry that corner's delta, so adding them
        # double-counts it; the bilinear term is exactly that double count, and
        # subtracting it leaves every border texel sitting on the delta it was
        # assigned. Averaging the overlaps instead — which is what this did
        # first — diluted the outer `feather` texels of each edge end with the
        # perpendicular edge's correction, measured at up to 63% of the intended
        # value three texels in and exactly zero everywhere else.
        vertical = wt[..., None] * top[None, :, :] + wb[..., None] * bottom[None, :, :]
        horizontal = wl[..., None] * left[:, None, :] + wr[..., None] * right[:, None, :]
        bilinear = (
            (wt * wl)[..., None] * top[0]
            + (wt * wr)[..., None] * top[-1]
            + (wb * wl)[..., None] * bottom[0]
            + (wb * wr)[..., None] * bottom[-1]
        )
        faces[face] += vertical + horizontal - bilinear


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


def verify(out_dir: str, ref_dir: str, prefix: str, ref_prefix: str = "TychoSkymapII.t3_08192x04096_80") -> int:
    """Check every generated face against the Tycho asset already in the tree.

    Tycho is the reference because it is known to render correctly in Cesium, and
    both it and this map reach the GPU by the same path — `Resource.fetchImage`
    with `flipY`, then `CubeMap` with its own `flipY` — so a face that matches
    Tycho's orientation is by construction right for Cesium's lookup. That makes
    the reference worth more than reasoning about the convention.

    Read only after the faces are written, so the sky box is identical whether or
    not the reference is there — what is lost without it is the check, not the
    output. generate.sh mounts it when present and says how to get it when not.
    """
    worst = 1.0
    bad = 0
    print(f"{'face':6} {'best':>8} {'2nd':>8} {'margin':>8}  verdict")
    for face in FACE_ORDER:
        gen_path = os.path.join(out_dir, f"{prefix}_{face}.{FORMAT}")
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


def build(src: np.ndarray, size: int, ss: int, exposure: float, feather: int, out_dir: str, quality: int) -> str:
    """Render, reconcile and write one cut of the source. Returns its file prefix.

    Every cut is reprojected from the source rather than resampled from a larger
    one. Downscaling would be cheaper and worse on both counts this generator
    cares about: it inherits the larger cut's JPEG ringing, and it averages a
    kernel that was sized for a different texel, which is exactly the
    solid-angle argument in `render_face` run backwards. Reconciling the edges
    afterwards would also only approximate the fixup rather than reproduce it.
    """
    # All six are held at once so the edges can be reconciled before encoding;
    # 2048px faces are 50 MB each in linear float, which is affordable where the
    # source is not.
    faces = {face: render_face(src, face, size, ss) for face in FACE_ORDER}

    pairs = edge_pairs(size)
    mean, p99 = edge_step(faces, pairs, exposure)
    print(f"  edge step before: mean {mean:.2f}, p99 {p99:.2f} levels", flush=True)
    if feather:
        # A fixed texel count, not a fixed angle: both sides of the trade it was
        # tuned against — a ramp steep enough to read as its own line, and a
        # correction carried far enough to land on more of the tone curve — are
        # counted in texels, so the optimum does not move with the face size.
        match_edges(faces, pairs, feather)
        mean, p99 = edge_step(faces, pairs, exposure)
        print(f"  edge step after:  mean {mean:.2f}, p99 {p99:.2f} levels ({feather}-texel feather)", flush=True)

    prefix = f"deepstar_2020_{size}"
    total = 0
    for face in FACE_ORDER:
        pixels = encode(faces[face], exposure)
        path = os.path.join(out_dir, f"{prefix}_{face}.{FORMAT}")
        cv2.imwrite(path, np.ascontiguousarray(pixels), [QUALITY_FLAG, quality])
        total += os.path.getsize(path)
    print(f"  wrote six faces, {total / 2**20:.1f} MB", flush=True)
    return prefix


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Build a Cesium sky box from NASA SVS Deep Star Maps 2020.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    ap.add_argument("--res", default="16k", choices=["8k", "16k", "32k"], help="source map resolution (8k/16k/32k download about 106 MB/423 MB/1.5 GB, cached)")
    ap.add_argument("--size", type=int, nargs="+", default=[2048, 1024], metavar="N",
                    help="cube face edge in pixels; several build several cuts from the one source")
    ap.add_argument("--supersample", default="auto", help="samples per output texel per axis, or auto from the source resolution")
    ap.add_argument("--match-edges", type=int, default=4, metavar="N",
                    help="reconcile adjacent faces over their outermost N texels; 0 leaves them alone")
    ap.add_argument("--quality", type=int, default=95, help=f"{FORMAT} quality; 101 is lossless")
    ap.add_argument("--exposure", default="auto", help="float, or auto")
    ap.add_argument("--no-verify", action="store_true", help="skip the orientation check")
    # Bind mounts, set by generate.sh. Overridable for running this outside docker.
    ap.add_argument("--cache", default="/cache", help="where source EXRs are kept")
    ap.add_argument("--out", default="/out", help="where cube faces are written")
    ap.add_argument("--ref", default="/ref", help="reference faces for the orientation check")
    args = ap.parse_args()

    # No mkdir: both are bind mounts of committed directories, and generate.sh
    # has already refused to run if either is missing. Creating them here would
    # only paper over a mount that did not happen.
    free = shutil.disk_usage(args.cache).free
    if free < 2 * 2**30:
        print(f"warning: {free / 2**30:.1f} GiB free in the cache mount", flush=True)

    src = open_source(fetch(f"starmap_2020_{args.res}.exr", args.cache))
    h, w = src.shape[:2]
    print(f"source {w}x{h} float16", flush=True)

    # Once, from the source, and shared by every cut. Measuring it per cut would
    # let two maps of the same sky disagree about how bright it is, which is
    # exactly what a viewer switching between them would notice first.
    if args.exposure == "auto":
        exposure = auto_exposure(src)
        print(f"auto exposure {exposure:.6g} (p{EXPOSURE_PERCENTILE} of luminance at the knee)", flush=True)
    else:
        exposure = float(args.exposure)
        print(f"exposure {exposure:.6g}", flush=True)

    prefixes = []
    for size in args.size:
        ss = default_supersample(size, w) if args.supersample == "auto" else int(args.supersample)
        print(f"\n{size}px faces, {ss}x{ss} samples per texel", flush=True)
        prefixes.append(build(src, size, ss, exposure, args.match_edges, args.out, args.quality))

    if args.no_verify:
        return 0
    if not os.path.isdir(args.ref):
        print("\nno reference faces mounted, skipping the orientation check", flush=True)
        return 0
    # Each cut on its own: `star_field` takes both sides down to a common 1024
    # before correlating, so the check reads the same at any face size.
    failures = 0
    for prefix in prefixes:
        print(f"\n{prefix}")
        failures += verify(args.out, args.ref, prefix)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
