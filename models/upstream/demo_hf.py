"""
Detect and decode QR codes using OpenCV's WeChatQRCode contrib module.

Usage:
    python demo.py \
        --detect detect_2026april.onnx \
        --sr     sr_2026april.onnx \
        --image  example_outputs/input_image.jpg \
        --output output_image.png

Requires: pip install opencv-contrib-python
"""
import argparse
import cv2 as cv


def detect_qr(detect_model: str, sr_model: str,
              image_path: str, output_path: str = "output_image.png"):
    img = cv.imread(image_path)
    if img is None:
        raise FileNotFoundError(f"Could not read image: {image_path}")
    print(f"Image size: {img.shape[1]}×{img.shape[0]}")

    try:
        detector = cv.wechat_qrcode_WeChatQRCode(detect_model, sr_model)
    except AttributeError:
        raise RuntimeError(
            "cv2.wechat_qrcode_WeChatQRCode not found.\n"
            "Install OpenCV with contrib modules:\n"
            "    pip install opencv-contrib-python"
        )

    texts, points = detector.detectAndDecode(img)

    output_img = img.copy()
    for text, corners in zip(texts, points):
        pts = corners.astype(int)
        cv.polylines(output_img, [pts.reshape(-1, 1, 2)],
                     isClosed=True, color=(0, 255, 0), thickness=2)
        origin = (int(pts[0][0]), max(int(pts[0][1]) - 8, 14))
        cv.putText(output_img, text, origin,
                   cv.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2, cv.LINE_AA)

    cv.imwrite(output_path, output_img)
    print(f"Saved annotated image to: {output_path}")

    if texts:
        print(f"\nDecoded {len(texts)} QR code(s):")
        for i, text in enumerate(texts, 1):
            print(f"  [{i}] {text}")
    else:
        print("\nNo QR codes found.")

    return list(texts)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Detect and decode QR codes using WeChatQR ONNX models"
    )
    parser.add_argument("--detect", required=True, help="Path to detect_*.onnx")
    parser.add_argument("--sr",     required=True, help="Path to sr_*.onnx")
    parser.add_argument("--image",  required=True, help="Path to input image")
    parser.add_argument("--output", default="output_image.png",
                        help="Path for annotated output (default: output_image.png)")
    args = parser.parse_args()

    detect_qr(args.detect, args.sr, args.image, args.output)
