#!/usr/bin/env python3
"""Download the official OpenCV 5.x WeChat QRCode ONNX models.

The models come from the same place `opencv_extra/testdata/dnn/download_models.py`
fetches them (they are the models used by OpenCV's own wechat_qrcode tests):

  detect.onnx : https://github.com/omrope79/opencv-test-models/releases/download/v1.1.0/detect.onnx
  sr.onnx     : https://github.com/omrope79/opencv-test-models/releases/download/v1.1.0/sr.onnx

They are byte identical to the copies published on Hugging Face
(`Andranik/wechat_qrcode_onnx`), e.g. `detect_2026april.onnx` / `sr_2026april.onnx`.

Usage:
    python tools/fetch_models.py
"""
import hashlib
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
UPSTREAM = os.path.join(ROOT, "models", "upstream")

MODELS = {
    "detect.onnx": (
        "https://github.com/omrope79/opencv-test-models/releases/download/v1.1.0/detect.onnx",
        "8dff596d81e6c223f188defc2616df1c83a406ae",
    ),
    "sr.onnx": (
        "https://github.com/omrope79/opencv-test-models/releases/download/v1.1.0/sr.onnx",
        "854b183017c2303cc429bcaf598cc7fc18e076a6",
    ),
}


def sha1(path):
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    os.makedirs(UPSTREAM, exist_ok=True)
    for name, (url, expected) in MODELS.items():
        dst = os.path.join(UPSTREAM, name)
        if os.path.isfile(dst) and sha1(dst) == expected:
            print("already present:", dst)
            continue
        print("downloading:", url)
        urllib.request.urlretrieve(url, dst)
        actual = sha1(dst)
        if actual != expected:
            raise SystemExit("sha1 mismatch for %s: %s != %s" % (dst, actual, expected))
        print("saved:", dst)
    print("done")


if __name__ == "__main__":
    sys.exit(main())
