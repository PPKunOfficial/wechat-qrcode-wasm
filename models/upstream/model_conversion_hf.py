
import sys
import os
import argparse
import hashlib

# Only use sys.path if caffe2onnx isn't installed in your pip/conda env
sys.path.insert(0, "/path/to/cloned/caffe2onnx")

def compute_sha256(filepath):
    """Compute SHA-256 hash of a file for integrity verification."""
    sha256 = hashlib.sha256()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            sha256.update(chunk)
    return sha256.hexdigest()


def convert_caffe_to_onnx(prototxt, caffemodel, onnx_path):
    """
    Convert a single Caffe model (.prototxt + .caffemodel) to ONNX.

    Parameters
    ----------
    prototxt   : str — path to Caffe .prototxt (network architecture)
    caffemodel : str — path to Caffe .caffemodel (weights)
    onnx_path  : str — output .onnx file path
    """
    from caffe2onnx.src.load_save_model import loadcaffemodel, saveonnxmodel
    from caffe2onnx.src.caffe2onnx import Caffe2Onnx

    assert os.path.isfile(prototxt), "Prototxt not found: {}".format(prototxt)
    assert os.path.isfile(caffemodel), "Caffemodel not found: {}".format(caffemodel)

    print("Converting: {} -> {}".format(prototxt, onnx_path))

    graph, params = loadcaffemodel(prototxt, caffemodel)
    converter = Caffe2Onnx(graph, params, onnx_path)
    onnx_model = converter.createOnnxModel()

    saveonnxmodel(onnx_model, onnx_path)

    sha = compute_sha256(onnx_path)
    print("  Saved: {} (SHA-256: {})".format(onnx_path, sha))
    return sha

MODELS = {
    "detect": ("dnn-models/dnn/wechat_2021-01/detect.prototxt", "dnn-models/dnn/wechat_2021-01/detect.caffemodel"),
    "sr":     ("dnn-models/dnn/wechat_2021-01/sr.prototxt",     "dnn-models/dnn/wechat_2021-01/sr.caffemodel"),
}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Convert WeChatQR Caffe models to ONNX.")
    parser.add_argument("--input_dir", default=".",
                        help="Directory with Caffe model files (default: cwd)")
    parser.add_argument("--output_dir", default=".",
                        help="Directory for output ONNX files (default: cwd)")
    args = parser.parse_args()

    try:
        from caffe2onnx.src.load_save_model import loadcaffemodel, saveonnxmodel
        from caffe2onnx.src.caffe2onnx import Caffe2Onnx
    except ImportError:
        print("Error: caffe2onnx is not installed.")
        print("  pip install caffe2onnx")
        sys.exit(1)

    os.makedirs(args.output_dir, exist_ok=True)

    print("=" * 60)
    print("WeChatQR Caffe -> ONNX Conversion")
    print("  Input  : {}".format(args.input_dir))
    print("  Output : {}".format(args.output_dir))
    print("=" * 60)

    for name, (proto_file, caffe_file) in MODELS.items():
        proto_path = os.path.join(args.input_dir, proto_file)
        caffe_path = os.path.join(args.input_dir, caffe_file)
        onnx_path  = os.path.join(args.output_dir, name + "_2026april.onnx.onnx")

        convert_caffe_to_onnx(proto_path, caffe_path, onnx_path)

    print("=" * 60)
    print("Done.")
