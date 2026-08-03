# Everything the base map generator needs, so nothing has to be installed on the
# host. GDAL does the fetching and the tiling; numpy, which comes with the image,
# is used only by the comparison against the reference tileset at the end.
#
# Pinned, and not only for reproducibility. gdal2tiles.py in 3.14 is a thin shim
# over the new `gdal raster tile` algorithm, and that one does not write
# `tilemapresource.xml` — the single file Cesium reads to learn the tiling scheme,
# and the one the app's own probe reads to decide whether this imagery is present
# at all (see `highresImageryMissing`). Tiles alone would look like a complete run
# and leave the layer reported as missing. 3.11 still writes it; tiles.py checks
# that it did rather than trusting the version.
FROM ghcr.io/osgeo/gdal:ubuntu-small-3.11.3

# gdal2tiles holds whole overview levels in the block cache while it builds them.
# The default is a fraction of host RAM, which in Docker's VM is small enough to
# thrash; 512 MB is comfortably more than level 5 of this source needs.
ENV GDAL_CACHEMAX=512

WORKDIR /work
COPY tiles.py /work/tiles.py
ENTRYPOINT ["python3", "/work/tiles.py"]
