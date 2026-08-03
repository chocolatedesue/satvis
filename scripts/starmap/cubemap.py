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


def face_basis(face: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(normal, du, dv) as signed unit axes, read out of `FACES` itself.

    Every entry there is a signed axis permutation, so evaluating it at three
    points recovers the frame exactly — no second copy of the convention to keep
    in step with the first.
    """
    zero, one = np.zeros(1), np.ones(1)
    sample = lambda u, v: np.array([float(np.asarray(c).item()) for c in FACES[face](u, v)])  # noqa: E731
    normal = sample(zero, zero)
    return normal, sample(one, zero) - normal, sample(zero, one) - normal


def edge_pairs(size: int) -> list[tuple[tuple[str, np.ndarray, np.ndarray], tuple[str, np.ndarray, np.ndarray]]]:
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

    # (u, v) along the boundary, and the pixels those belong to. v runs bottom to
    # top while rows run top to bottom, hence -centres for the vertical sides.
    sides = {
        "top": (centres, ones, (np.zeros(size, int), idx)),
        "bottom": (centres, -ones, (np.full(size, size - 1), idx)),
        "left": (-ones, -centres, (idx, np.zeros(size, int))),
        "right": (ones, -centres, (idx, np.full(size, size - 1))),
    }

    seen: set[frozenset] = set()
    pairs = []
    for face, (u, v, (rows, cols)) in ((f, s) for f in FACE_ORDER for s in sides.values()):
        normal, du, dv = face_basis(face)
        edge = normal[:, None] + du[:, None] * u + dv[:, None] * v

        # The neighbour is whichever face this boundary direction points into.
        others = [f for f in FACE_ORDER if f != face]
        bases = [face_basis(f) for f in others]
        depth = np.array([n @ edge for n, _, _ in bases])
        far = others[int(np.argmax(depth[:, 0]))]
        nb_normal, nb_du, nb_dv = face_basis(far)

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
            raise AssertionError(f"{face} border does not land on {far} texels (off by {drift:.3g})")

        key = frozenset((face, far))
        here = (face, rows, cols)
        there = (far, np.round(ny).astype(int), np.round(nx).astype(int))
        if key not in seen:
            seen.add(key)
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


def edge_step(faces: dict[str, np.ndarray], pairs, exposure: float) -> tuple[float, float]:
    """Mean and p99 brightness difference across the shared edges, in 8-bit levels.

    Measured after `encode`, because the tone curve is steep where this map is
    dark: a difference the eye can see in the sky is far below one 8-bit level in
    linear radiance, and a linear metric reports it as nothing.
    """
    diffs = []
    for (fa, ya, xa), (fb, yb, xb) in pairs:
        a = encode(faces[fa][ya, xa], exposure).astype(np.float32)
        b = encode(faces[fb][yb, xb], exposure).astype(np.float32)
        diffs.append(np.abs(a - b).max(axis=1))
    joined = np.concatenate(diffs)
    return float(joined.mean()), float(np.percentile(joined, 99))


def match_edges(faces: dict[str, np.ndarray], pairs, feather: int) -> None:
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
    parent: dict[tuple[str, int, int], tuple[str, int, int]] = {}

    def find(k):
        parent.setdefault(k, k)
        while parent[k] != k:
            parent[k] = parent[parent[k]]
            k = parent[k]
        return k

    for (fa, ya, xa), (fb, yb, xb) in pairs:
        for i in range(len(ya)):
            ka, kb = find((fa, int(ya[i]), int(xa[i]))), find((fb, int(yb[i]), int(xb[i])))
            if ka != kb:
                parent[ka] = kb

    groups: dict[tuple[str, int, int], list] = {}
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
    ap.add_argument("--match-edges", type=int, default=4, metavar="N",
                    help="reconcile adjacent faces over their outermost N texels; 0 leaves them alone")
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
    # No mkdir: both are bind mounts of committed directories, and generate.sh
    # has already refused to run if either is missing. Creating them here would
    # only paper over a mount that did not happen.
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

    # All six are held at once so the edges can be reconciled before encoding;
    # 2048px faces are 50 MB each in linear float, which is affordable where the
    # source is not.
    faces = {face: render_face(layers, face, args.size, ss) for face in FACE_ORDER}

    pairs = edge_pairs(args.size)
    mean, p99 = edge_step(faces, pairs, exposure)
    print(f"edge step before: mean {mean:.2f}, p99 {p99:.2f} levels", flush=True)
    if args.match_edges:
        match_edges(faces, pairs, args.match_edges)
        mean, p99 = edge_step(faces, pairs, exposure)
        print(f"edge step after:  mean {mean:.2f}, p99 {p99:.2f} levels ({args.match_edges}-texel feather)", flush=True)

    total = 0
    for face in FACE_ORDER:
        pixels = encode(faces[face], exposure)
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
