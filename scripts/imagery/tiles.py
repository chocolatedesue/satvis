"""Build the offline base map tileset from Natural Earth II.

Fetches the source raster, applies the recolor the Cesium asset was graded with,
cuts it into a TMS pyramid and checks the result against the tileset it replaces.
Everything runs here rather than in the shell wrapper, so a run is reproducible
from the image alone.

The source is Natural Earth II with Shaded Relief, Water and Drainages at 10m —
21600x10800, EPSG:4326, public domain. Output is `data/imagery/NaturalEarthII`,
a geodetic TMS pyramid of 256px WebP that `TileMapServiceImageryProvider` reads
directly, taking the extension from the manifest so nothing in the app names the
format. Levels 0-2 are tracked and 3-5 are gitignored; see data/imagery/.gitignore.

Two things are worth knowing before changing anything.

**The tileset this replaces is not raw Natural Earth II.** The retired
`Flowm/cesium-assets` was cut from a Photoshop grade of the public source, darker
and cooler, and that is the imagery the app showed for years. Tiling the raw source
lands 48 levels per channel away from it — a markedly brighter, flatter globe.
`RECOLOR` below is that grade, recovered rather than guessed; see `fit_recolor`.

**The recolor goes on before the pyramid, never after.** Averaging and a nonlinear
curve do not commute, so a curve applied to finished tiles would give a different
answer at every level above the base. Applied as a VRT, which costs no disk and
lets GDAL apply it as it reads.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
import zipfile
from urllib.request import Request, urlopen

import numpy as np
from osgeo import gdal

gdal.UseExceptions()

SOURCE = "NE2_HR_LC_SR_W_DR"
BASE_URL = "https://naciscdn.org/naturalearth/10m/raster"

# The archive the committed base levels were built from.
#
# Pinned because levels 0-2 of the output are committed, which only means anything
# if the input is fixed. Natural Earth 2 has been stable since 2012 (the TIFF is
# dated 2012-07-16, VERSION.txt says 2.0.0) but the url carries no version, so a
# new release would silently replace it — and `Content-Length` alone cannot notice
# a same-size change, nor tell a changed upstream from a half-finished download.
#
# A mismatch is fatal rather than retried. Regenerating from a different source
# would rewrite the committed tiles, and that has to be somebody's decision.
SOURCE_SHA256 = "e4a6e27c121cab119835ac38f17695768011d12a2a7d9e57d5cddf65566fcec0"

# Level 5 is the base of the pyramid; everything above it is an average of it.
#
# Fixed rather than a flag, because it decides the bytes of the committed levels: at
# depth 5 level 2 is an average of averages down from the base, at depth 2 it is
# tiled straight from the source, and the two measurably disagree. A `--zoom 3`
# convenience would have rewritten 42 tracked files with different pixels.
MAX_ZOOM = 5

# How deep the committed part of the pyramid goes. The manifest always declares
# exactly this, whatever was built — see `write_manifest`.
COMMITTED_ZOOM = 2

# WebP 85 is ~19 MB for the whole pyramid, against 25 MB as JPEG at the same number
# and 49 MB for the tileset it replaces. Measured at level 4 against a lossless cut:
# q75 is 47% of JPEG q85's bytes for slightly more error, q80 60%, q85 77% for less
# error, q90 106% for clearly less. 85 is the point where WebP is strictly better
# than the JPEG it replaced on bytes and on error at once.
#
# A constant for the same reason the depth is one — see `MAX_ZOOM`.
QUALITY = 85

# What this writes, and what the tileset it is compared against wrote. Both are
# needed at once by `verify`, which reads one of each.
TILE_EXT = "webp"
REF_EXT = "jpg"

# The grade the Cesium asset was cut with, as GDAL VRT lookup tables: `in:out`
# knots per band, linearly interpolated between, clamped outside.
#
# Recovered rather than guessed. `fit_recolor` tiles the raw source, builds a
# joint histogram of raw against reference over all 2048 base-level tiles (134
# million pixels a band) and takes the conditional median. The spread around it is
# 1 to 10 levels, so the grade really is three independent per-channel curves and
# not, say, a targeted replacement of the ocean fill.
#
# Knots every 16 levels, not all 256: the difference between this and the full
# curve is at most 4 levels anywhere and 0.03 levels in the weighted mean, well
# under the ~2 levels of JPEG noise that both sides of the comparison carry. Few
# enough to read and to review; dense enough to be exact.
#
# No gamma or levels expression, because none fits — the source was graded in
# Photoshop and the curve is hand-drawn. Fitting `black + (white-black)*x**g` to
# the red channel is 7 levels out at the quarter tone whichever way the exponent
# is chosen.
#
# The leading flat run on each band is extrapolation, not measurement: Natural
# Earth II holds no red below 53 or green and blue below ~85, so those inputs
# never occur and the curve is held level rather than invented.
#
# Refitting reproduces these numbers only on the GDAL the Dockerfile pins — the
# raw tiles the fit reads are resampled by that same GDAL, and 3.14 shifts them by
# up to 3 levels in the blue. That is far below the noise floor and does not matter
# for the output; it does mean a diff here after a GDAL bump is expected rather
# than alarming.
RECOLOR = (
    "0:15,53:15,64:21,80:33,96:47,112:63,128:80,144:97,160:114,176:132,192:151,208:170,224:190,240:209,255:225",
    "0:34,85:34,96:41,112:53,128:66,144:81,160:100,176:122,192:147,208:170,224:194,240:217,255:227",
    "0:35,83:35,96:39,112:49,128:60,144:72,160:85,176:102,192:129,208:161,224:186,240:217,255:225",
)

# What `verify` will accept as a match, per channel, in 8-bit levels. The floor is
# ~2 (red, green) and ~3 (blue), and it is lossy encoding on both sides — WebP here
# against the reference's JPEG — so even a perfect curve cannot agree exactly. Six
# leaves that room and still fails loudly on the thing worth catching: an unapplied
# or wrong curve, which is 48.
MATCH_TOLERANCE = 6.0


def checksum(path: str) -> str:
    """SHA-256 of a file, read in blocks so 311 MB does not become 311 MB of RAM."""
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def check_source(path: str) -> None:
    """Stop unless the archive is the one the committed base levels came from.

    Checked on a cache hit too: a resume can append a changed upstream's tail onto
    an old file's head, and `Content-Length` matches at the end of that.

    Fatal, and no retry — a corrupted cache and a new upstream release want opposite
    responses, and guessing risks quietly publishing a base map nobody chose.
    """
    got = checksum(path)
    if got == SOURCE_SHA256:
        return
    raise SystemExit(
        f"\n{os.path.basename(path)} is not the archive this generator is pinned to.\n"
        f"  expected {SOURCE_SHA256}\n"
        f"  actual   {got}\n\n"
        "Either the cached copy is damaged — delete it and run again — or Natural Earth\n"
        "published a new release. If the new source is wanted, update SOURCE_SHA256 in\n"
        "this file and commit the regenerated levels 0-2 along with it: they are tracked,\n"
        "and a different source means different pixels."
    )


def fetch(cache_dir: str) -> str:
    """Download the source archive, resuming a partial file and skipping a whole one.

    Worth resuming rather than restarting: it is 311 MB and the cache is a bind
    mount that survives the container. Whatever comes out is checksummed by
    `check_source`, which is what makes resuming safe to attempt at all.
    """
    name = f"{SOURCE}.zip"
    dest = os.path.join(cache_dir, name)
    url = f"{BASE_URL}/{name}"
    with urlopen(Request(url, method="HEAD")) as head:  # noqa: S310 — fixed host, see BASE_URL
        want = int(head.headers.get("Content-Length") or 0)
    have = os.path.getsize(dest) if os.path.exists(dest) else 0

    if want and have == want:
        print(f"cached   {name} ({have / 2**20:.0f} MB)", flush=True)
        check_source(dest)
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
    check_source(dest)
    return dest


def extract(zip_path: str, cache_dir: str) -> str:
    """Unpack the raster and its world file, keeping both in the cache.

    The `.tfw` and `.prj` travel with the `.tif` and are not optional: the TIFF
    carries no georeferencing of its own, and without them GDAL sees a plain image
    and the tiler has nothing to place on the globe.
    """
    tif = os.path.join(cache_dir, f"{SOURCE}.tif")
    members = [f"{SOURCE}.tif", f"{SOURCE}.tfw", f"{SOURCE}.prj"]
    if all(os.path.exists(os.path.join(cache_dir, m)) for m in members):
        print(f"cached   {SOURCE}.tif ({os.path.getsize(tif) / 2**20:.0f} MB)", flush=True)
        return tif

    print(f"extracting {SOURCE}.tif (667 MB)", flush=True)
    with zipfile.ZipFile(zip_path) as z:
        for member in members:
            z.extract(member, cache_dir)
    return tif


def recolored(tif: str, vrt_path: str) -> str:
    """The source with `RECOLOR` applied, as a VRT.

    A VRT rather than a second GeoTIFF: GDAL applies the curve as blocks are read,
    so this costs no disk and no separate pass over 667 MB.

    Only the source element is rewritten — `SimpleSource` to `ComplexSource`, since
    only the latter carries a `<LUT>`. Everything else stays as GDAL wrote it, so the
    georeferencing is never transcribed twice and cannot drift.
    """
    gdal.Translate(vrt_path, tif, format="VRT")
    tree = ET.parse(vrt_path)
    bands = tree.getroot().findall("VRTRasterBand")
    if len(bands) != len(RECOLOR):
        raise SystemExit(f"expected {len(RECOLOR)} bands in {SOURCE}.tif, found {len(bands)}")
    for band, lut in zip(bands, RECOLOR):
        source = band.find("SimpleSource")
        if source is None:
            raise SystemExit("no SimpleSource in the translated VRT — GDAL changed its output")
        source.tag = "ComplexSource"
        ET.SubElement(source, "LUT").text = lut
    tree.write(vrt_path)
    return vrt_path


def write_manifest(out_dir: str) -> None:
    """Rewrite the manifest to declare only the committed levels.

    gdal2tiles declares every level it built, which would make this tracked file
    change on every run. Trimming it to `COMMITTED_ZOOM` keeps the committed copy
    byte-identical, and that copy is what a checkout without the generated levels
    serves — so what it claims has to be what such a checkout has.

    The real depth is settled by `__IMAGERY_MAX_LEVEL__`, which overrides it. That
    bias is deliberate: forgetting to raise the ceiling serves a soft globe, where a
    manifest promising absent levels would 404 every tile in them.

    Written out rather than edited because every value is a constant of the geodetic
    scheme or of this generator — which is what makes the file deterministic.
    """
    upp = [f"{0.703125 / 2**z:.14f}" for z in range(COMMITTED_ZOOM + 1)]
    tilesets = "\n".join(f'        <TileSet href="{z}" units-per-pixel="{upp[z]}" order="{z}"/>' for z in range(COMMITTED_ZOOM + 1))
    with open(os.path.join(out_dir, "tilemapresource.xml"), "w") as f:
        f.write(
            '<?xml version="1.0" encoding="utf-8"?>\n'
            '    <TileMap version="1.0.0" tilemapservice="http://tms.osgeo.org/1.0.0">\n'
            f"      <Title>{SOURCE}</Title>\n"
            "      <Abstract></Abstract>\n"
            "      <SRS>EPSG:4326</SRS>\n"
            '      <BoundingBox minx="-180.00000000000000" miny="-90.00000000000000" maxx="180.00000000000000" maxy="90.00000000000000"/>\n'
            '      <Origin x="-180.00000000000000" y="-90.00000000000000"/>\n'
            f'      <TileFormat width="256" height="256" mime-type="image/{TILE_EXT}" extension="{TILE_EXT}"/>\n'
            '      <TileSets profile="geodetic">\n'
            f"{tilesets}\n"
            "      </TileSets>\n"
            "    </TileMap>\n"
        )


def tile(src: str, out_dir: str, zoom: int, processes: int) -> None:
    """Cut `src` into a geodetic TMS pyramid of WebP tiles.

    `--tmscompatible` is what makes level 0 two tiles at 0.703125 deg/px rather than
    one stretched over the whole globe. That is the scheme Cesium's
    `GeographicTilingScheme` assumes and the one the reference tileset uses; without
    it every tile would be requested at the wrong level.

    WebP rather than JPEG for the reasons measured at `QUALITY`. Cesium takes the
    extension from the manifest, so this is the only line that decides the format.
    """
    subprocess.run(
        [
            "gdal2tiles.py",
            "--profile=geodetic",
            "--tmscompatible",
            f"--zoom=0-{zoom}",
            "--tiledriver=WEBP",
            f"--webp-quality={QUALITY}",
            # Averaging, so a coarse tile is the mean of the four below it rather
            # than one of their pixels. The alternative shows as shimmering coastlines
            # when the globe is zoomed out, which is most of the time in this app.
            "--resampling=average",
            f"--processes={processes}",
            "--no-kml",
            "--webviewer=none",
            src,
            out_dir,
        ],
        check=True,
    )

    # gdal2tiles writes this; `gdal raster tile`, which it becomes in 3.14, does not.
    # Its content is replaced below either way, but its absence still means the tiler
    # is not the one this was written against, and the tiles it produced are not to be
    # trusted just because they are numerous.
    if not os.path.exists(os.path.join(out_dir, "tilemapresource.xml")):
        raise SystemExit(
            "gdal2tiles wrote no tilemapresource.xml, so it is no longer the tiler this\n"
            "expects. Pin an older GDAL in the Dockerfile, or confirm the tile layout\n"
            "before trusting the output."
        )
    write_manifest(out_dir)


def tile_paths(a_dir: str, b_dir: str, zoom: int, stride: int, a_ext: str = TILE_EXT, b_ext: str = REF_EXT) -> list[tuple[str, str]]:
    """Tiles present in both trees at `zoom`, sampled every `stride` in x and y.

    Two extensions because the two sides differ: this writes WebP, the tileset it is
    checked against is JPEG. GDAL reads both.

    Sampled rather than exhaustive to keep the check to a few seconds, and spread
    over the whole grid: a wrong curve is uniform, but a wrong source or a misplaced
    pyramid shows up regionally.
    """
    width = 2 ** (zoom + 1)
    pairs = []
    for x in range(0, width, stride):
        for y in range(0, width // 2, stride):
            a = os.path.join(a_dir, str(zoom), str(x), f"{y}.{a_ext}")
            b = os.path.join(b_dir, str(zoom), str(x), f"{y}.{b_ext}")
            if os.path.exists(a) and os.path.exists(b):
                pairs.append((a, b))
    return pairs


def read_tile(path: str) -> np.ndarray:
    ds = gdal.Open(path)
    return np.dstack([ds.GetRasterBand(b + 1).ReadAsArray() for b in range(3)])


def verify(out_dir: str, ref_dir: str, zoom: int) -> int:
    """Compare the generated tiles against the tileset they replace.

    The reference is the imagery the app shipped for years, and so the definition of
    "unchanged". Read only after the tiles are written — no output depends on it.

    A few levels of disagreement are expected, not a defect: both sides are lossy and
    the curve was fitted through that same noise. What this catches is a curve not
    applied, or applied wrongly — an order of magnitude larger, and instantly visible.
    """
    pairs = tile_paths(out_dir, ref_dir, zoom, stride=3)
    if not pairs:
        print(f"no overlapping tiles at level {zoom}, nothing to compare")
        return 0

    gen = np.concatenate([read_tile(a).reshape(-1, 3) for a, _ in pairs]).astype(np.float32)
    ref = np.concatenate([read_tile(b).reshape(-1, 3) for _, b in pairs]).astype(np.float32)
    diff = np.abs(gen - ref)

    print(f"{len(pairs)} tiles at level {zoom}, {len(gen):,} pixels")
    print(f"{'':6} {'mean':>8} {'p99':>8}  verdict")
    worst = 0.0
    for i, name in enumerate("RGB"):
        mean = float(diff[:, i].mean())
        p99 = float(np.percentile(diff[:, i], 99))
        worst = max(worst, mean)
        print(f"{name:6} {mean:8.2f} {p99:8.1f}  {'ok' if mean <= MATCH_TOLERANCE else 'TOO FAR'}")
    print()
    if worst > MATCH_TOLERANCE:
        print(f"the generated imagery differs from the reference by {worst:.1f} levels in the mean,")
        print(f"against a tolerance of {MATCH_TOLERANCE:.0f}. Around 48 means the recolor was not applied;")
        print("anything else means RECOLOR no longer matches the reference — re-derive it")
        print("with --fit-recolor rather than widening the tolerance.")
        return 1
    print(f"matches the reference tileset, worst channel {worst:.2f} levels in the mean")
    return 0


def fit_recolor(tif: str, ref_dir: str, cache_dir: str, processes: int) -> int:
    """Re-derive `RECOLOR` from the raw source and the reference tileset.

    Not part of a normal run — the curve is a property of an asset that has not
    changed since 2013, so it is committed rather than refitted every time. This is
    here so that the constant is reproducible instead of merely asserted, and so it
    can be rebuilt if the reference is ever regraded.

    The raw source is tiled to the base level first so both sides have been through
    the same resampling onto the same grid; comparing source pixels against tiles
    would fold the pyramid's averaging into the curve.

    The conditional median, not the mean: lossy encoding puts ringing on both sides,
    and near a coastline that is a long tail rather than symmetric noise.
    """
    raw_dir = os.path.join(cache_dir, "raw-tiles")
    if not os.path.exists(os.path.join(raw_dir, "tilemapresource.xml")):
        print("tiling the raw source for comparison", flush=True)
        shutil.rmtree(raw_dir, ignore_errors=True)
        tile(tif, raw_dir, MAX_ZOOM, processes)

    pairs = tile_paths(raw_dir, ref_dir, MAX_ZOOM, stride=1)
    if not pairs:
        raise SystemExit("no reference tiles to fit against")
    print(f"fitting over {len(pairs)} tile pairs", flush=True)

    hist = np.zeros((3, 256, 256), np.int64)  # [band][raw][reference]
    for a, b in pairs:
        raw, ref = read_tile(a), read_tile(b)
        for c in range(3):
            np.add.at(hist[c], (raw[:, :, c].ravel(), ref[:, :, c].ravel()), 1)

    print("\nRECOLOR = (")
    for c in range(3):
        counts = hist[c].sum(axis=1)
        cumulative = np.cumsum(hist[c], axis=1)
        median = np.full(256, -1.0)
        for v in range(256):
            # Below this an input is too rare for its median to mean anything.
            if counts[v] >= 50:
                median[v] = float(np.searchsorted(cumulative[v], counts[v] / 2.0))
        seen = np.flatnonzero(median >= 0)
        # Interpolate across inputs the source never produces, then force the curve
        # monotone: a LUT that steps backwards would invert contrast locally.
        curve = np.maximum.accumulate(np.interp(np.arange(256), seen, median[seen]))
        lo, hi = int(seen[0]), int(seen[-1])
        knots = sorted({0, lo, *(v for v in range(0, 256, 16) if lo < v < hi), hi, 255})
        print('    "' + ",".join(f"{v}:{int(round(curve[v]))}" for v in knots) + '",')
    print(")")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Build the offline base map tileset from Natural Earth II.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    ap.add_argument("--processes", type=int, default=os.cpu_count() or 4, help="tiler workers")
    ap.add_argument("--no-recolor", action="store_true", help="tile the raw source, skipping the Cesium grade")
    ap.add_argument("--no-verify", action="store_true", help="skip the comparison against the reference tileset")
    ap.add_argument("--fit-recolor", action="store_true", help="re-derive RECOLOR from the reference and print it")
    # Bind mounts, set by generate.sh. Overridable for running this outside docker.
    ap.add_argument("--cache", default="/cache", help="where the source raster is kept")
    ap.add_argument("--out", default="/out", help="where the tileset is written")
    ap.add_argument("--ref", default="/ref", help="reference tileset for the comparison")
    args = ap.parse_args()

    # No mkdir: both are bind mounts of committed directories, and generate.sh has
    # already refused to run if either is missing. Creating them here would only
    # paper over a mount that did not happen.
    free = shutil.disk_usage(args.cache).free
    if free < 2 * 2**30:
        print(f"warning: {free / 2**30:.1f} GiB free in the cache mount", flush=True)

    tif = extract(fetch(args.cache), args.cache)

    if args.fit_recolor:
        if not os.path.isdir(args.ref):
            raise SystemExit(
                "--fit-recolor needs the tileset the grade came from. Clone it with:\n"
                "  git clone --depth 1 https://github.com/Flowm/cesium-assets scripts/.reference/cesium-assets"
            )
        return fit_recolor(tif, args.ref, args.cache, args.processes)

    src = tif if args.no_recolor else recolored(tif, os.path.join(args.cache, f"{SOURCE}_recolored.vrt"))
    print(f"source {SOURCE}.tif, {'raw' if args.no_recolor else 'recolored'}", flush=True)

    # Built in a staging directory and swapped in, so an interrupted run cannot leave
    # a half-written pyramid where the app expects a whole one.
    out_dir = os.path.join(args.out, "NaturalEarthII")
    staging = os.path.join(args.out, ".NaturalEarthII.partial")
    shutil.rmtree(staging, ignore_errors=True)
    tile(src, staging, MAX_ZOOM, args.processes)
    shutil.rmtree(out_dir, ignore_errors=True)
    os.rename(staging, out_dir)

    total = sum(os.path.getsize(os.path.join(root, f)) for root, _, files in os.walk(out_dir) for f in files)
    tiles = sum(len(files) for _, _, files in os.walk(out_dir))
    print(f"\nwrote {tiles - 1} tiles to levels 0-{MAX_ZOOM}, {total / 2**20:.0f} MB", flush=True)

    if args.no_verify:
        return 0
    if not os.path.isdir(args.ref):
        print("\nno reference tileset mounted, skipping the comparison", flush=True)
        return 0
    if args.no_recolor:
        # The reference is graded; raw output is ~48 levels from it by definition.
        # Comparing anyway would fail a run that did exactly what was asked.
        print("\n--no-recolor: skipping the comparison, the reference is graded and this is not", flush=True)
        return 0
    print()
    return verify(out_dir, args.ref, MAX_ZOOM)


if __name__ == "__main__":
    sys.exit(main())
