# WeChatQR — QR Code Detection and Decoding

QR code detection and decoding using WeChat CV Team's deep learning models, integrated via OpenCV contrib.

---

## Models

| File | Role |
|---|---|
| `detect_2026april.onnx` | Detects QR code regions in the image |
| `sr_2026april.onnx` | Super-resolves each region for better decoding |

Both models are passed directly to the `WeChatQRCode` API — no manual preprocessing needed.

---

## Usage

```bash
python demo.py \
    --detect detect_2026april.onnx \
    --sr     sr_2026april.onnx \
    --image  example_outputs/input_image.jpg \
    --output example_outputs/output_image.png
```

---

## Example Output

| Input | Output |
|---|---|
| ![input](example_outputs/input_image.jpg) | ![output](example_outputs/output_image.png) |

---

## License

See [LICENSE](./LICENSE). Original models by WeChat CV Team.
