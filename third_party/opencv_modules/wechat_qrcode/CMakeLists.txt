set(the_description "WeChat QR code Detector")
ocv_define_module(wechat_qrcode opencv_core opencv_geometry opencv_imgproc opencv_dnn)

# NOTE(wasm port): vendored copy of opencv_contrib/modules/wechat_qrcode (5.x branch).
# Local changes vs upstream:
#   - removed "opencv_objdetect" dependency: the module sources neither include nor use it.
#   - removed "WRAP java objc python js": this port exposes a small C API
#     (src/wq_wasm.cpp) instead of language bindings.
#   - removed the configure-time caffe model download block: the 5.x code path loads
#     ONNX models (dnn::readNetFromONNX), and the .onnx files ship with this repo.

# iconv support isn't automatic on some systems
if(CMAKE_VERSION VERSION_GREATER "3.11")
  find_package(Iconv QUIET)
  if(Iconv_FOUND)
    ocv_target_link_libraries(${the_module} Iconv::Iconv)
  else()
    ocv_target_compile_definitions(${the_module} PRIVATE "NO_ICONV=1")
  endif()
endif()
