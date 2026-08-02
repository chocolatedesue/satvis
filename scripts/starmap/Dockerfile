# Everything the star map generator needs, so nothing has to be installed on the
# host. numpy does the reprojection; OpenCV is here for two things it happens to
# be good at and that are otherwise painful — reading half-float EXR and writing
# JPEG — rather than for any computer vision.
FROM python:3.12-slim

# OpenCV gates EXR decoding behind this since 4.10; without it imread returns None.
ENV OPENCV_IO_ENABLE_OPENEXR=1
# Keep numpy from oversubscribing a laptop while the container is the only thing
# running. Reprojection is memory-bandwidth bound long before it is core bound.
ENV OMP_NUM_THREADS=4

# numpy is deliberately unpinned: opencv pins a compatible range itself, and
# pinning both just produces an unsolvable resolution.
RUN pip install --no-cache-dir "opencv-python-headless==4.12.*"

WORKDIR /work
COPY cubemap.py /work/cubemap.py
ENTRYPOINT ["python", "/work/cubemap.py"]
