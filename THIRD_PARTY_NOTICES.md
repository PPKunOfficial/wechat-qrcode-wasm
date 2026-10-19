# 第三方组件与许可

本项目以 **Apache-2.0** 发布（见 [LICENSE](LICENSE)、[NOTICE](NOTICE)）。仓库里的源码、预编译 wasm 与模型包含下列第三方组件。

## 随仓库分发的组件

| 组件 | 版本 / 来源 | 位置 | 许可 |
| --- | --- | --- | --- |
| OpenCV（core / imgproc / flann / geometry / dnn） | 5.x（`OpenCV 5.1.0-dev`） | 静态链接进 `dist/wq.wasm` | Apache-2.0 |
| opencv_contrib `wechat_qrcode`（含 ZXing C++ 移植） | 5.x @ `eca97a4` | `third_party/opencv_modules/wechat_qrcode/` | Apache-2.0（Tencent 版权） |
| Protocol Buffers | 3.19.1 | 静态链接进 `dist/wq.wasm` | BSD-3-Clause |
| zlib | 1.3.2 | 静态链接进 `dist/wq.wasm` | zlib |
| HarfBuzz | 14.2（OpenCV 依赖链） | 静态链接进 `dist/wq.wasm` | Old MIT |
| Emscripten runtime（musl libc、compiler-rt） | 6.0.12 | `dist/wq.js` | MIT / Apache-2.0 with LLVM exception |
| WeChat QRCode 模型 `detect.onnx` / `sr.onnx` | WeChat QRCode project | `models/` | Apache-2.0（Tencent，见 `models/LICENSE`） |

仅用于测试/基准、不会随产物分发的 devDependencies：`zxing-wasm`（MIT）、`jsQR`（Apache-2.0）、`puppeteer-core`（Apache-2.0）。

## 我们对上游文件做过的修改（Apache-2.0 §4(b)）

| 文件 | 修改 |
| --- | --- |
| `third_party/opencv_modules/wechat_qrcode/CMakeLists.txt` | 去掉未使用的 `opencv_objdetect` 依赖、去掉 `WRAP java objc python js`、删掉 5.x 已失效的 caffe 模型下载块。详见同目录 `UPSTREAM.md`。 |
| `models/sr.onnx` | 把固化成 `Slice(ends=[447,447])` 的裁剪改成动态尺寸，输入/输出改为符号维度。生成脚本 `tools/patch_sr_model.py`；未修改的原模型保留在 `models/upstream/sr.onnx`。 |
| 其余 | `src/wq_wasm.cpp`、`web/`、`scripts/`、`tools/`、`demo/`、`tests/`、`docs/` 均为本仓库原创。 |

`models/detect.onnx` 与上游发布文件逐字节一致（sha1 校验见 `tools/fetch_models.py`）。

## 完整许可文本

- **Apache-2.0**：本仓库 [LICENSE](LICENSE)；WeChat QRCode 模块与模型：[third_party/opencv_modules/wechat_qrcode/LICENSE](third_party/opencv_modules/wechat_qrcode/LICENSE)、[models/LICENSE](models/LICENSE)
- **BSD-3-Clause（Protocol Buffers）**：

```
Copyright 2008 Google Inc.  All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

    * Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following disclaimer
in the documentation and/or other materials provided with the
distribution.
    * Neither the name of Google Inc. nor the names of its
contributors may be used to endorse or promote products derived from
this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

- **zlib**：

```
Copyright (C) 1995-2024 Jean-loup Gailly and Mark Adler

This software is provided 'as-is', without any express or implied
warranty.  In no event will the authors be held liable for any damages
arising from the use of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it
freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not
   claim that you wrote the original software. If you use this software
   in a product, an acknowledgment in the product documentation would be
   appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be
   misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.
```

- **Old MIT（HarfBuzz）**：

```
HarfBuzz is licensed under the so-called "Old MIT" license.  Details follow.
For parts of HarfBuzz that are licensed under different licenses see individual
files names COPYING in subdirectories where applicable.

Copyright © 2010,2011,2012,2013,2014,2015,2016,2017,2018,2019,2020,2021,2022  Google, Inc.
Copyright © 2019  Facebook, Inc.
Copyright © 2012  Mozilla Foundation
Copyright © 2011  Codethink Limited
Copyright © 2008,2010  Nokia Corporation and/or its subsidiary(-ies)
Copyright © 2009  Keith Stribley
Copyright © 2009  Martin Hosken and SIL International
Copyright © 2007  Chris Wilson
Copyright © 2006  Behdad Esfahbod
Copyright © 2005  David Turner
Copyright © 2004,2007,2008,2009,2010  Red Hat, Inc.
Copyright © 1998-2004  David Turner and Werner Lemberg
Copyright © 2016  Elie Roux <elie.roux@telecom-bretagne.eu>
Copyright © 2018  Khaled Hosny

For full copyright notices consult the individual files in the package.

Permission is hereby granted, without written agreement and without
license or royalty fees, to use, copy, modify, and distribute this
software and its documentation for any purpose, provided that the
above copyright notice and the following two paragraphs appear in
all copies of this software.

IN NO EVENT SHALL THE COPYRIGHT HOLDER BE LIABLE TO ANY PARTY FOR
DIRECT, INDIRECT, SPECIAL, INCIDENTAL, OR CONSEQUENTIAL DAMAGES
ARISING OUT OF THE USE OF THIS SOFTWARE AND ITS DOCUMENTATION, EVEN
IF THE COPYRIGHT HOLDER HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH
DAMAGE.

THE COPYRIGHT HOLDER SPECIFICALLY DISCLAIMS ANY WARRANTIES, INCLUDING,
BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS FOR A PARTICULAR PURPOSE.  THE SOFTWARE PROVIDED HEREUNDER IS
ON AN "AS IS" BASIS, AND THE COPYRIGHT HOLDER HAS NO OBLIGATION TO
PROVIDE MAINTENANCE, SUPPORT, UPDATES, ENHANCEMENTS, OR MODIFICATIONS.
```

## 商标

“WeChat”“微信”是腾讯的商标。本项目是独立的社区移植，**与腾讯、OpenCV、ZXing 作者无隶属关系，也未获其背书**；相关名称仅用于说明算法与模型的来源。
