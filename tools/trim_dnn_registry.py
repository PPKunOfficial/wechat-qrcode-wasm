#!/usr/bin/env python3
"""Comment out unused `CV_DNN_REGISTER_LAYER_CLASS` lines in OpenCV's dnn init.cpp.

The dnn module registers *every* layer implementation in `modules/dnn/src/init.cpp`
through function pointers.  An indirect reference from a registry keeps the layer's
object file alive at link time, so even `--gc-sections` cannot drop code this build
never uses.  Commenting the unused registrations lets the linker leave those archive
members out, which shrinks the wasm binary without touching optimisation flags.

Only the layer types the bundled WeChat models instantiate are kept.  Selection is
empirical: build with tracing, run the corpus, collect `[WQTRACE-LAYER]` names.

Usage:
    python tools/trim_dnn_registry.py --opencv D:/projects/ocv --revert
    python tools/trim_dnn_registry.py --opencv D:/projects/ocv
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

# Layer types created by models/detect.onnx + models/sr.onnx (probed by tracing
# LayerFactory::createLayerInstance during a full scan, including super-resolution).
KEEP = {
    "BatchNorm2",
    "Concat2",
    "Conv2",
    "ConvTranspose2",
    "DetectionOutput",
    "MaxPool",
    "NaryEltwise",
    "Pad2",
    "PriorBox",
    "ReLU",
    "Reshape2",
    "Slice2",
    "Softmax",
    "Transpose",
}

REGISTER_RE = re.compile(r"^(\s*)CV_DNN_REGISTER_LAYER_CLASS\(\s*(\w+)\s*,")
COMMENTED_RE = re.compile(
    r"^(\s*)//\s*(?:\[trim-dnn-registry\]\s*)?CV_DNN_REGISTER_LAYER_CLASS\(\s*(\w+)\s*,"
)


def process(text: str) -> tuple[str, int, int]:
    """Return (new_text, kept, commented)."""
    out = []
    kept = commented = 0
    for line in text.splitlines(keepends=True):
        m = REGISTER_RE.match(line)
        if m:
            name = m.group(2)
            if name in KEEP:
                kept += 1
            else:
                line = f"{m.group(1)}// [trim-dnn-registry] {line.lstrip()}"
                commented += 1
            out.append(line)
            continue
        m = COMMENTED_RE.match(line)
        if m:
            name = m.group(2)
            if name in KEEP:
                # Restore registrations that a previous run commented out.
                body = line[m.end(1):]
                body = body[body.index("CV_DNN_REGISTER_LAYER_CLASS"):]
                line = f"{m.group(1)}{body}"
                kept += 1
            out.append(line)
            continue
        out.append(line)
    return "".join(out), kept, commented


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--opencv", required=True, help="root of the OpenCV checkout")
    parser.add_argument("--revert", action="store_true", help="restore every commented registration")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    path = Path(args.opencv) / "modules/dnn/src/init.cpp"
    if not path.is_file():
        print(f"error: {path} not found", file=sys.stderr)
        return 1

    original = path.read_text(encoding="utf-8")
    if args.revert:
        restored = []
        count = 0
        for line in original.splitlines(keepends=True):
            m = COMMENTED_RE.match(line)
            if m:
                body = line[m.end(1):]
                body = body[body.index("CV_DNN_REGISTER_LAYER_CLASS"):]
                line = f"{m.group(1)}{body}"
                count += 1
            restored.append(line)
        text = "".join(restored)
        kept, commented = count, 0
        action = "restored"
    else:
        text, kept, commented = process(original)
        action = "commented"

    if text == original:
        print(f"no change: {kept} used registrations kept, 0 {action}")
        return 0
    if not args.dry_run:
        path.write_text(text, encoding="utf-8")
    print(f"{action} {commented} registrations ({kept} kept) in {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
