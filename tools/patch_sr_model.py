#!/usr/bin/env python3
"""Make the official wechat_qrcode super-resolution ONNX model accept any input size.

Why this is needed
------------------
`wechat_qrcode` runs the SR network on the *cropped QR patch*, whose size depends on
the detected QR code (typically anything from ~60x60 up to a few hundred pixels).
`SuperScale::superResoutionScale()` therefore does:

    dnn::blobFromImage(src, blob, 1.0 / 255, Size(src.cols, src.rows), ...)   // dynamic size!

The upstream `sr.onnx` was converted from Caffe by caffe2onnx, which froze the
`Crop` layer into an ONNX ``Slice`` with *static* ends (224 input -> 447 output):

    Slice(Crop1) : starts=[0,0] ends=[447,447] axes=[2,3] on the 2x nearest-upsampled input

With an input of e.g. 150x130 the deconvolutions produce 299x259 while the frozen
slice clamps to min(447, 2*H) = 300x260, so ``Add`` sees mismatching shapes and the
DNN engine throws. In Caffe the Crop layer copied the shape of the reference tensor
(dynamic), so this patch restores that semantics.

What this script changes (nothing else is touched)
--------------------------------------------------
1. ``Crop1_ends22`` : [447, 447]  ->  [-1, -1]
   ONNX Slice with a negative end means "input_dim - 1", i.e. crop the last row/column
   of the 2x nearest-upsampled tensor, which is exactly the shape produced by the
   ConvTranspose branch (2H-1 x 2W-1). For 224 input the output is still 447x447 and
   the result is numerically identical to the upstream model.
2. graph input ``data_input`` : [1,1,224,224] -> [1,1,H,W] (symbolic dims)
   graph output ``fc``          : [1,1,447,447] -> unset (dynamic)
   so runtimes shape-infer from the actual blob.

Usage:
    python tools/patch_sr_model.py
"""
import os
import sys

import numpy as np
import onnx
from onnx import numpy_helper

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, "models", "upstream", "sr.onnx")
DST = os.path.join(ROOT, "models", "sr.onnx")


def main():
    if not os.path.isfile(SRC):
        raise SystemExit("missing %s - run tools/fetch_models.py first" % SRC)

    model = onnx.load(SRC)

    # 1) dynamic crop: slice to input_dim - 1
    patched = False
    for init in model.graph.initializer:
        if init.name == "Crop1_ends22":
            patched = True
            init.CopyFrom(numpy_helper.from_array(np.array([-1, -1], dtype=np.int64), "Crop1_ends22"))
    if not patched:
        raise SystemExit("Crop1_ends22 initializer not found - unexpected model layout")

    # 2) symbolic input/output spatial dimensions
    for vi in model.graph.input:
        if vi.name == "data_input":
            shape = vi.type.tensor_type.shape
            shape.dim[0].dim_value = 1
            shape.dim[1].dim_value = 1
            shape.dim[2].dim_param = "H"
            shape.dim[3].dim_param = "W"
    for vi in model.graph.output:
        if vi.name == "fc":
            shape = vi.type.tensor_type.shape
            shape.dim[2].dim_param = "OH"
            shape.dim[3].dim_param = "OW"

    onnx.checker.check_model(model)
    onnx.save(model, DST)
    print("wrote", DST)


if __name__ == "__main__":
    sys.exit(main())
