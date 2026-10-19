// C API around the OpenCV 5.x wechat_qrcode module, compiled to WebAssembly.
//
// The module keeps the complete upstream pipeline: the SSD (ONNX) QR detector, the
// ONNX super-resolution network and the zxing-derived multi-binarizer decoder.
// This file only marshals buffers in/out and turns the result into JSON so that a
// small JS wrapper can consume it.
//
// Data flow:
//   JS heap (RGBA/RGB/GRAY pixels)  ->  cv::Mat (no copy)  ->  cvtColor/convert
//   ->  WeChatQRCode::detectAndDecode(img, quads)
//   ->  JSON: {"ok":true,"count":N,"ms":F,"results":[{"text":..,"points":[[x,y] x4]}]}
//
// All exported symbols are consumed by src/wq.js (see -sEXPORTED_FUNCTIONS in
// scripts/build-wasm.ps1).

#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#include <opencv2/core.hpp>
#include <opencv2/imgproc.hpp>
#include <opencv2/wechat_qrcode.hpp>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define WQ_EXPORT extern "C" EMSCRIPTEN_KEEPALIVE
#else
#define WQ_EXPORT extern "C"
#endif

namespace {

// Pixel formats of the incoming buffer (keep in sync with web/scanner.js).
enum PixelFormat {
    kFormatGray = 0,
    kFormatRgb = 1,
    kFormatRgba = 2,
    kFormatBgr = 3,
};

std::unique_ptr<cv::wechat_qrcode::WeChatQRCode> g_scanner;
std::string g_result = "{\"ok\":false,\"count\":0,\"results\":[],\"error\":\"not initialized\"}";
std::string g_last_error;

// Minimal JSON string escaping for QR payloads and error messages (UTF-8 passes
// through unchanged).
std::string json_escape(const std::string& in) {
    std::string out;
    out.reserve(in.size() + 8);
    for (unsigned char c : in) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", static_cast<unsigned>(c));
                    out += buf;
                } else {
                    out += static_cast<char>(c);
                }
        }
    }
    return out;
}

void set_error(const std::string& message) {
    g_last_error = message;
    g_result = "{\"ok\":false,\"count\":0,\"results\":[],\"error\":\"" + json_escape(g_last_error) + "\"}";
}

// detectAndDecode() returns CV_32FC2 corner quads, but older/newer builds of the
// module returned them with a few different Mat layouts. Accept all of the
// plausible ones and fall back to a raw float reinterpretation.
std::vector<cv::Point2f> read_quad(const cv::Mat& m) {
    std::vector<cv::Point2f> quad;
    if (m.empty()) return quad;
    quad.reserve(4);
    if (m.channels() == 2 && m.total() == 4) {
        for (int i = 0; i < 4; ++i) {
            const cv::Vec2f v = m.at<cv::Vec2f>(i / m.cols, i % m.cols);
            quad.emplace_back(v[0], v[1]);
        }
        return quad;
    }
    if (m.channels() == 1 && m.total() == 8) {
        for (int i = 0; i < 4; ++i) {
            quad.emplace_back(m.at<float>(i, 0), m.at<float>(i, 1));
        }
        return quad;
    }
    // Generic fallback: reinterpret as float and take the first 4 (x, y) pairs.
    if (m.depth() == CV_32F && m.total() * m.channels() >= 8) {
        const cv::Mat cont = m.isContinuous() ? m : m.clone();
        const float* p = reinterpret_cast<const float*>(cont.ptr(0));
        for (int i = 0; i < 4; ++i) quad.emplace_back(p[2 * i], p[2 * i + 1]);
    }
    return quad;
}

}  // namespace

// Initializes the scanner: both paths must point at readable ONNX files.
// Returns 0 on success, -1 on failure (see wq_last_error()).
WQ_EXPORT int wq_init(const char* detect_onnx_path, const char* super_resolution_onnx_path) {
    try {
        g_scanner.reset();
        const std::string detect = detect_onnx_path ? detect_onnx_path : "";
        const std::string sr = super_resolution_onnx_path ? super_resolution_onnx_path : "";
        if (detect.empty()) {
            set_error("detector ONNX model path is required");
            return -1;
        }
        g_scanner = std::make_unique<cv::wechat_qrcode::WeChatQRCode>(detect, sr);
        g_last_error.clear();
        g_result = "{\"ok\":true,\"count\":0,\"results\":[]}";
        return 0;
    } catch (const cv::Exception& e) {
        set_error(std::string("cv::Exception: ") + e.what());
        return -1;
    } catch (const std::exception& e) {
        set_error(std::string("std::exception: ") + e.what());
        return -1;
    }
}

// Scans one image.
//   data   : pointer into the wasm heap, `height` rows of `stride` bytes
//   format : 0=GRAY8, 1=RGB8, 2=RGBA8, 3=BGR8
//   scale  : detector scale factor in (0, 1], <= 0 keeps the module default
// Returns the length of the JSON result (also available via wq_result_json),
// or -1 on failure.
WQ_EXPORT int wq_scan(const uint8_t* data, int width, int height, int stride, int format,
                      float scale_factor) {
    if (!g_scanner) {
        set_error("wq_init() has not been called");
        return -1;
    }
    if (!data || width <= 0 || height <= 0) {
        set_error("invalid input buffer");
        return -1;
    }
    if (stride <= 0) stride = width * (format == kFormatGray ? 1 : (format == kFormatRgba ? 4 : 3));
    // OpenCV cannot handle images this small for QR detection.
    if (width <= 20 || height <= 20) {
        g_result = "{\"ok\":true,\"count\":0,\"results\":[]}";
        return static_cast<int>(g_result.size());
    }

    try {
        const auto start = std::chrono::steady_clock::now();

        int cv_type = CV_8UC1;
        switch (format) {
            case kFormatGray: cv_type = CV_8UC1; break;
            case kFormatRgb: cv_type = CV_8UC3; break;
            case kFormatRgba: cv_type = CV_8UC4; break;
            case kFormatBgr: cv_type = CV_8UC3; break;
            default:
                set_error("unsupported pixel format");
                return -1;
        }
        // Wrap the wasm heap memory: no copy, no allocation.
        cv::Mat image(height, width, cv_type, const_cast<uint8_t*>(data), static_cast<size_t>(stride));

        cv::Mat gray;
        if (format == kFormatGray) {
            gray = image;
        } else {
            const int code = (format == kFormatRgb) ? cv::COLOR_RGB2GRAY
                            : (format == kFormatRgba) ? cv::COLOR_RGBA2GRAY
                                                      : cv::COLOR_BGR2GRAY;
            cv::cvtColor(image, gray, code);
        }

        g_scanner->setScaleFactor(scale_factor);

        std::vector<cv::Mat> quads;
        const std::vector<std::string> texts = g_scanner->detectAndDecode(gray, quads);

        const auto end = std::chrono::steady_clock::now();
        const double ms = std::chrono::duration<double, std::milli>(end - start).count();

        std::string json;
        json.reserve(256);
        char header[160];
        std::snprintf(header, sizeof(header),
                      "{\"ok\":true,\"width\":%d,\"height\":%d,\"ms\":%.2f,\"count\":%d,\"results\":[",
                      width, height, ms, static_cast<int>(texts.size()));
        json += header;
        for (size_t i = 0; i < texts.size(); ++i) {
            if (i) json += ',';
            json += "{\"text\":\"";
            json += json_escape(texts[i]);
            json += "\",\"points\":[";
            std::vector<cv::Point2f> quad = (i < quads.size()) ? read_quad(quads[i])
                                                               : std::vector<cv::Point2f>();
            if (quad.size() != 4) {
                // Missing/odd corner data: emit an empty quad rather than lying.
                quad.clear();
            }
            for (size_t j = 0; j < quad.size(); ++j) {
                if (j) json += ',';
                char pt[64];
                std::snprintf(pt, sizeof(pt), "[%.2f,%.2f]", quad[j].x, quad[j].y);
                json += pt;
            }
            json += "]}";
        }
        json += "]}";
        g_result.swap(json);
        g_last_error.clear();
        return static_cast<int>(g_result.size());
    } catch (const cv::Exception& e) {
        set_error(std::string("cv::Exception: ") + e.what());
    } catch (const std::exception& e) {
        set_error(std::string("std::exception: ") + e.what());
    } catch (...) {
        set_error("unknown exception while scanning");
    }
    return -1;
}

// Pointer to the NUL-terminated JSON produced by the last successful wq_scan().
WQ_EXPORT const char* wq_result_json() { return g_result.c_str(); }

// Pointer to the NUL-terminated description of the last error, "" if none.
WQ_EXPORT const char* wq_last_error() { return g_last_error.c_str(); }

// Frees the detector/SR models (useful for tests that initialize repeatedly).
WQ_EXPORT void wq_reset() { g_scanner.reset(); }

// Version information of the linked OpenCV, for diagnostics.
WQ_EXPORT const char* wq_opencv_version() { return CV_VERSION; }

namespace {
// Referenced so that the linker keeps this translation unit's diagnostics happy in
// builds without EMSCRIPTEN_KEEPALIVE (e.g. native smoke tests).
const char* const kWqBuildTag = "wechat_qrcode wasm wrapper";
}  // namespace
