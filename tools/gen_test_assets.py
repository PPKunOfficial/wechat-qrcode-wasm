#!/usr/bin/env python3
"""Generates the deterministic QR test corpus used by the node/browser benchmarks.

Every asset is written twice:
  tests/assets/png/<id>.png    screenshot-friendly image (used by the demo)
  tests/assets/raw/<id>.rgba   raw RGBA8 bytes (fed straight into the wasm scanner)

tests/assets/manifest.json describes each asset (payload = ground truth).

The point of the corpus is to stress the pipeline the way a phone camera does:
small codes (super-resolution path), motion blur, compression artifacts, low light,
glare, perspective and rotation. The set is intentionally hard: a plain QR image is
not a useful accuracy benchmark for WeChat's model.

Usage:
    python tools/gen_test_assets.py [--out tests/assets] [--seed 1234]

Requires: segno, pillow, numpy  (python -m pip install segno pillow numpy)
"""

from __future__ import annotations

import argparse
import io
import json
import math
import random
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

import segno


PAYLOADS = {
    "url": "https://opencv.org/wechat-qrcode-wasm",
    "text_zh": "微信扫码模块已移植到 WebAssembly，这是一个中文载荷测试。",
    "wifi": "WIFI:T:WPA;S:opencv-wasm-demo;P:wechat2021;;",
    "vcard": (
        "BEGIN:VCARD\nVERSION:3.0\nN:QRCode;WeChat;;;\nFN:WeChat QRCode\n"
        "ORG:OpenCV WASM\nTEL:+8613800000000\nEMAIL:qr@example.com\nEND:VCARD"
    ),
    "long": "https://example.com/" + "segment/".join(str(i) for i in range(12)) + "?q=1",
}


def qr_image(payload: str, *, scale: int = 8, border: int = 4, error: str = "m") -> Image.Image:
    """Renders a payload as a crisp QR image (L mode, one module = `scale` px)."""
    qr = segno.make(payload, error=error)
    buf = io.BytesIO()
    qr.save(buf, kind="png", scale=scale, border=border)
    buf.seek(0)
    return Image.open(buf).convert("L")


def scene_background(size: tuple[int, int], rng: random.Random) -> Image.Image:
    """Light paper-like background with a subtle gradient and a few blobs.

    Keeps the corpus from being "black code on pure white", which any decoder passes.
    """
    w, h = size
    top = rng.randint(200, 245)
    bottom = rng.randint(160, 215)
    vert = np.linspace(top, bottom, h, dtype=np.float32)[:, None]
    grad = np.repeat(vert, w, axis=1)
    arr = np.stack([grad, grad * rng.uniform(0.94, 1.0), grad * rng.uniform(0.88, 1.0)], axis=-1)
    img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), mode="RGB")

    draw = ImageDraw.Draw(img)
    for _ in range(rng.randint(2, 6)):
        rx = rng.randint(0, w)
        ry = rng.randint(0, h)
        rad = rng.randint(max(20, min(w, h) // 12), max(40, min(w, h) // 4))
        shade = rng.randint(150, 245)
        draw.ellipse((rx - rad, ry - rad, rx + rad, ry + rad), fill=(shade, shade, shade))
    return img.filter(ImageFilter.GaussianBlur(radius=rng.uniform(0.4, 1.6)))


def paste_qr(background: Image.Image, qr: Image.Image, *, center: tuple[int, int]) -> Image.Image:
    """Pastes the QR in the middle of the scene, adding a quiet zone and mild border."""
    canvas = background.copy()
    qr = qr.convert("RGB")
    qw, qh = qr.size
    x = int(center[0] - qw / 2)
    y = int(center[1] - qh / 2)
    # white quiet zone behind the code (a real screen/print has one)
    pad = max(6, min(qw, qh) // 12)
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((x - pad, y - pad, x + qw + pad, y + qh + pad), fill=(250, 250, 250))
    canvas.paste(qr, (x, y))
    return canvas


def add_glare(img: Image.Image, rng: random.Random) -> Image.Image:
    w, h = img.size
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    cx = rng.uniform(0.25, 0.75) * w
    cy = rng.uniform(0.25, 0.75) * h
    radius = max(w, h) * rng.uniform(0.25, 0.5)
    dist = np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2)
    mask = np.clip(1.0 - dist / radius, 0.0, 1.0) ** 1.6
    arr = np.asarray(img).astype(np.float32)
    arr += (mask[:, :, None] * 110.0)
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), mode="RGB")


def rotate(img: Image.Image, degrees: float, fill: tuple[int, int, int]) -> Image.Image:
    return img.rotate(degrees, resample=Image.BICUBIC, expand=False, fillcolor=fill)


def perspective(img: Image.Image, rng: random.Random) -> Image.Image:
    """Warps the image as if the camera looks at it from an angle."""
    w, h = img.size
    jitter = lambda: rng.uniform(-0.06, 0.06) * min(w, h)  # noqa: E731
    tl = (0 + jitter(), 0 + jitter())
    tr = (w - 1 + jitter(), 0 + jitter())
    br = (w - 1 + jitter(), h - 1 + jitter())
    bl = (0 + jitter(), h - 1 + jitter())
    # PIL PERSPECTIVE wants coefficients mapping output -> input; the output corners are
    # the full rectangle, the input corners are the jittered quad.
    coeffs = perspective_coeffs((tl, tr, br, bl), ((0, 0), (w - 1, 0), (w - 1, h - 1), (0, h - 1)))
    return img.transform(img.size, Image.PERSPECTIVE, coeffs, Image.BICUBIC)


def perspective_coeffs(src, dst):
    """Returns the 8 coefficients mapping output corners (dst) to input corners (src).

    Both quads may be given as a flat 8-tuple or as four (x, y) pairs, in the order
    top-left, top-right, bottom-right, bottom-left (PIL's PERSPECTIVE convention).
    """
    a = []
    b = []
    for (x, y), (u, v) in zip(to_quad(dst), to_quad(src)):
        a.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        a.append([0, 0, 0, x, y, 1, -v * x, -v * y])
        b += [u, v]
    coeffs = np.linalg.solve(np.asarray(a, dtype=np.float64), np.asarray(b, dtype=np.float64))
    return tuple(coeffs.tolist())


def to_quad(value):
    """Normalizes a quad given as 8 numbers or 4 points into four (x, y) pairs."""
    if len(value) == 4 and all(hasattr(p, "__len__") and len(p) == 2 for p in value):
        return [(float(p[0]), float(p[1])) for p in value]
    if len(value) == 8:
        return [(float(value[2 * i]), float(value[2 * i + 1])) for i in range(4)]
    raise ValueError(f"expected a quad of 4 points or 8 numbers, got {value!r}")


def downscale_up(img: Image.Image, factor: float) -> Image.Image:
    w, h = img.size
    small = img.resize((max(8, int(w * factor)), max(8, int(h * factor))), Image.BILINEAR)
    return small.resize((w, h), Image.BICUBIC)


def build(seed: int, out_dir: Path) -> list[dict]:
    rng = random.Random(seed)
    png_dir = out_dir / "png"
    raw_dir = out_dir / "raw"
    png_dir.mkdir(parents=True, exist_ok=True)
    raw_dir.mkdir(parents=True, exist_ok=True)

    entries: list[dict] = []

    def write_asset(asset_id: str, img: Image.Image, meta: dict) -> None:
        img = img.convert("RGB")
        png_path = png_dir / f"{asset_id}.png"
        raw_path = raw_dir / f"{asset_id}.rgba"
        img.save(png_path, "PNG")
        rgba = img.convert("RGBA")
        raw_path.write_bytes(rgba.tobytes())
        entries.append(
            {
                "id": asset_id,
                "width": img.width,
                "height": img.height,
                "png": f"png/{asset_id}.png",
                "raw": f"raw/{asset_id}.rgba",
                **meta,
            }
        )

    def emit(asset_id: str, payload: str, img: Image.Image, tags: list[str], note: str = "") -> None:
        write_asset(asset_id, img, {"payload": payload, "tags": tags, "note": note})

    def emit_multi(asset_id: str, payloads: list[str], img: Image.Image, note: str) -> None:
        """Multi-code scene: `expect` is the number of distinct codes that must be decoded."""
        write_asset(asset_id, img, {"payload": payloads[0], "payloads": payloads, "expect": len(payloads), "tags": ["multi"], "note": note})

    def fresh_qr(payload: str, *, scale: int, border: int = 4, error: str = "m") -> Image.Image:
        return qr_image(payload, scale=scale, border=border, error=error)

    # 1. clean reference (640x480, screen-sized code)
    for key in ("url", "text_zh", "wifi", "vcard", "long"):
        payload = PAYLOADS[key]
        bg = scene_background((640, 480), rng)
        qr = fresh_qr(payload, scale=6)
        emit(f"{key}_clean", payload, paste_qr(bg, qr, center=(320, 240)), ["clean"])

    # 2. small-in-large-image: the super-resolution / multi-scale decoding path
    for key in ("url", "text_zh", "wifi"):
        payload = PAYLOADS[key]
        bg = scene_background((1280, 720), rng)
        qr = fresh_qr(payload, scale=3)
        emit(f"{key}_small", payload, paste_qr(bg, qr, center=(rng.randint(400, 880), rng.randint(220, 500))), ["small"], "QR ~60-100px wide")

    # 3. blur (motion/defocus)
    for radius, tag in ((1.1, "blur_light"), (1.8, "blur_heavy")):
        payload = PAYLOADS["url"]
        bg = scene_background((640, 480), rng)
        qr = fresh_qr(payload, scale=5)
        img = paste_qr(bg, qr, center=(320, 240)).filter(ImageFilter.GaussianBlur(radius=radius))
        emit(f"url_{tag}", payload, img, ["blur"], f"gaussian radius={radius}")

    # 4. sensor noise + low light
    payload = PAYLOADS["text_zh"]
    bg = scene_background((640, 480), rng)
    qr = fresh_qr(payload, scale=5)
    base = np.asarray(paste_qr(bg, qr, center=(320, 240))).astype(np.float32)
    noisy = base + np.random.default_rng(seed).normal(0, 14, base.shape)
    emit("text_zh_noise", payload, Image.fromarray(np.clip(noisy, 0, 255).astype(np.uint8)), ["noise"], "gaussian sigma=14")
    dim = Image.fromarray(np.clip(base * 0.42 + 8, 0, 255).astype(np.uint8))
    emit("text_zh_dark", payload, dim, ["lowlight"], "brightness x0.42")

    # 5. low contrast (printed on grey, low quality camera)
    payload = PAYLOADS["wifi"]
    bg = scene_background((640, 480), rng)
    qr = fresh_qr(payload, scale=5)
    img = paste_qr(bg, qr, center=(320, 240))
    img = ImageEnhance.Contrast(img).enhance(0.42)
    emit("wifi_lowcontrast", payload, img, ["low_contrast"], "contrast x0.42")

    # 6. glare
    payload = PAYLOADS["url"]
    bg = scene_background((640, 480), rng)
    qr = fresh_qr(payload, scale=5)
    emit("url_glare", payload, add_glare(paste_qr(bg, qr, center=(320, 240)), rng), ["glare"])

    # 7. perspective / rotation
    payload = PAYLOADS["long"]
    bg = scene_background((720, 560), rng)
    qr = fresh_qr(payload, scale=5)
    img = paste_qr(bg, qr, center=(360, 280))
    emit("long_perspective", payload, perspective(img, rng), ["perspective"])
    emit("long_rot45", payload, rotate(img, 45, (235, 235, 235)), ["rotation"])
    emit("long_rot15", payload, rotate(img, 15, (235, 235, 235)), ["rotation"])

    # 8. heavy compression / upscaled blur (WeChat "scan a screenshot" case)
    payload = PAYLOADS["vcard"]
    bg = scene_background((800, 600), rng)
    qr = fresh_qr(payload, scale=5)
    img = paste_qr(bg, qr, center=(400, 300))
    emit("vcard_downscale", payload, downscale_up(img, 0.45), ["compression"], "downscale 0.45 then bicubic up")
    emit("vcard_blur_small", payload, downscale_up(img.filter(ImageFilter.GaussianBlur(1.2)), 0.6), ["small", "blur"])

    # 9. hard tier: phone-camera situations that a plain binarizer + finder-pattern scan cannot
    #    handle. These are the cases WeChat's detector + super-resolution path exists for.
    def hard_scene(payload: str, size: tuple[int, int], qr_scale: int) -> Image.Image:
        bg = scene_background(size, rng)
        qr = fresh_qr(payload, scale=qr_scale)
        x = int(size[0] * rng.uniform(0.3, 0.7))
        y = int(size[1] * rng.uniform(0.3, 0.7))
        return paste_qr(bg, qr, center=(x, y))

    # 9a. far shot: large scene, ~50px code (module < 2px) - needs detection + 2x upscale
    for key, size in (("url", (1600, 1200)), ("text_zh", (1280, 960)), ("wifi", (1920, 1080))):
        payload = PAYLOADS[key]
        img = hard_scene(payload, size, 2)
        emit(f"hard_{key}_far", payload, img, ["hard", "far"], "QR ~50-60px in a large frame")

    # 9b. far + motion blur: the code is soft before it is even downscaled by the camera
    img = hard_scene(PAYLOADS["url"], (1280, 960), 2).filter(ImageFilter.GaussianBlur(1.0))
    emit("hard_url_far_blur", PAYLOADS["url"], img, ["hard", "far", "blur"], "50px code + blur 1.0")

    # 9c. heavy defocus on a normal-sized code
    img = hard_scene(PAYLOADS["text_zh"], (640, 480), 5).filter(ImageFilter.GaussianBlur(2.8))
    emit("hard_text_zh_defocus", PAYLOADS["text_zh"], img, ["hard", "blur"], "gaussian radius=2.8")

    # 9d. night shot: very dark + noise + blur
    base = np.asarray(hard_scene(PAYLOADS["long"], (800, 600), 4).filter(ImageFilter.GaussianBlur(1.4))).astype(np.float32)
    night = base * 0.22 + np.random.default_rng(seed + 1).normal(0, 9, base.shape)
    emit("hard_long_night", PAYLOADS["long"], Image.fromarray(np.clip(night, 0, 255).astype(np.uint8)), ["hard", "lowlight"])
    # 9e. glare washing out one corner of the code
    glare = add_glare(hard_scene(PAYLOADS["vcard"], (720, 560), 4), rng)
    emit("hard_vcard_glare", PAYLOADS["vcard"], glare, ["hard", "glare"], "strong glare over one corner")

    # 9f. extreme perspective (camera at ~45 degrees) on a small code
    w, h = 900, 700
    img = hard_scene(PAYLOADS["url"], (w, h), 3)
    tl = (0.16 * w, 0.05 * h)
    tr = (0.98 * w, 0.20 * h)
    br = (0.86 * w, 0.97 * h)
    bl = (0.03 * w, 0.72 * h)
    coeffs = perspective_coeffs((tl, tr, br, bl), ((0, 0), (w - 1, 0), (w - 1, h - 1), (0, h - 1)))
    warped = img.transform(img.size, Image.PERSPECTIVE, coeffs, Image.BICUBIC, fillcolor=(240, 240, 240))
    emit("hard_url_tilted", PAYLOADS["url"], warped, ["hard", "perspective"], "~45 degree tilt")

    # 9g. screenshot of a screenshot: downscale hard, then blur, then add noise
    img = hard_scene(PAYLOADS["text_zh"], (1000, 750), 3)
    img = downscale_up(img, 0.35).filter(ImageFilter.GaussianBlur(1.2))
    arr = np.asarray(img).astype(np.float32) + np.random.default_rng(seed + 2).normal(0, 12, (img.height, img.width, 3))
    emit("hard_text_zh_recompressed", PAYLOADS["text_zh"], Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8)), ["hard", "compression", "noise"])

    # 9h. rotated small code (no axis-aligned gift for the finder-pattern scan)
    img = hard_scene(PAYLOADS["wifi"], (1280, 960), 3).rotate(28, resample=Image.BICUBIC, expand=False, fillcolor=(238, 238, 238))
    emit("hard_wifi_rotated", PAYLOADS["wifi"], img, ["hard", "rotation"], "28 degrees, ~60px code")
    # 10. multi-code scenes: the detector emits many candidate boxes (keep_top_k=100) and the
    # decoder walks all of them, so several codes in one frame are decoded in a single call.
    def multi_scene(payloads: list[str], size: tuple[int, int], centers: list[tuple[int, int]], qr_scale: int = 6) -> Image.Image:
        img = scene_background(size, rng)
        for payload, center in zip(payloads, centers):
            img = paste_qr(img, fresh_qr(payload, scale=qr_scale), center=center)
        return img

    emit_multi(
        "multi_two",
        [PAYLOADS["url"], PAYLOADS["wifi"]],
        multi_scene([PAYLOADS["url"], PAYLOADS["wifi"]], (1400, 720), [(340, 360), (1060, 360)]),
        "two different codes in one frame",
    )
    emit_multi(
        "multi_three",
        [PAYLOADS["url"], PAYLOADS["text_zh"], PAYLOADS["wifi"]],
        multi_scene(
            [PAYLOADS["url"], PAYLOADS["text_zh"], PAYLOADS["wifi"]],
            (1500, 900),
            [(300, 230), (1180, 260), (740, 690)],
        ),
        "three different codes in one frame",
    )
    emit_multi(
        "multi_duplicate",
        [PAYLOADS["vcard"], PAYLOADS["vcard"]],
        multi_scene([PAYLOADS["vcard"], PAYLOADS["vcard"]], (1200, 620), [(320, 310), (880, 310)]),
        "same payload twice: both quads must be reported (dedup is spatial, not by text)",
    )
    grid_payloads = [f"https://grid.example/item{i}" for i in range(9)]
    emit_multi(
        "multi_grid",
        grid_payloads,
        multi_scene(
            grid_payloads,
            (1600, 1100),
            [(310 + col * 490, 230 + row * 330) for row in range(3) for col in range(3)],
            qr_scale=5,
        ),
        "3x3 grid of distinct codes",
    )

    manifest = {
        "seed": seed,
        "generated_by": "tools/gen_test_assets.py",
        "count": len(entries),
        "assets": entries,
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
    return entries


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default="tests/assets", help="output directory (default: tests/assets)")
    parser.add_argument("--seed", type=int, default=20260119, help="deterministic RNG seed")
    args = parser.parse_args()

    out_dir = Path(args.out)
    if not out_dir.is_absolute():
        out_dir = (Path(__file__).resolve().parent.parent / out_dir).resolve()
    entries = build(args.seed, out_dir)
    total_png = sum((out_dir / e["png"]).stat().st_size for e in entries)
    total_raw = sum((out_dir / e["raw"]).stat().st_size for e in entries)
    print(f"wrote {len(entries)} assets to {out_dir}")
    print(f"  png: {total_png / 1024:.0f} KB   raw: {total_raw / 1024:.0f} KB")
    print(f"  manifest: {out_dir / 'manifest.json'}")


if __name__ == "__main__":
    main()
