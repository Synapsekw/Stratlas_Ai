# PoissonRecon and SurfaceTrimmer (M10 G1 for G3's photo/mesh.py), from mkazhdan/PoissonRecon
# (MIT) at the commit components.json pins. Upstream builds with a Makefile (Linux) and Visual
# Studio projects; this one CMake project builds the two tools the pack needs on Windows and macOS.
#
# Image libraries come from vcpkg (poissonrecon/vcpkg.json, static, through the vcpkg toolchain
# build-native.mjs passes): zlib, libpng 1.6 and libjpeg-turbo. Upstream's vendored copies in ZLIB/,
# PNG/ (libpng 1.2.29) and JPEG/ are not compiled: their zlib calls read, write, close and lseek
# without <unistd.h>, an error in C99 that current AppleClang enforces (pack-native darwin-arm64).
# PoissonRecon names them as "PNG/png.h" and, on Windows, "JPEG/jpeglib.h"; the forwarding
# headers written below send those names to vcpkg's headers, and the checkout itself is not on the
# include path, so a vendored header can never be picked up.
#
#   cmake -S tools/pipeline-pack/native/poissonrecon -B <build> -DPOISSONRECON_SOURCE=<checkout>
#         -DCMAKE_TOOLCHAIN_FILE=<vcpkg>/scripts/buildsystems/vcpkg.cmake -DVCPKG_MANIFEST_DIR=...
cmake_minimum_required(VERSION 3.21)
project(StratlasPoissonRecon C CXX)

if(NOT POISSONRECON_SOURCE OR NOT EXISTS "${POISSONRECON_SOURCE}/Src/PoissonRecon.cpp")
    message(FATAL_ERROR "Set POISSONRECON_SOURCE to a PoissonRecon checkout")
endif()
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
find_package(OpenMP REQUIRED COMPONENTS CXX)
find_package(ZLIB REQUIRED)
find_package(PNG REQUIRED)
find_package(JPEG REQUIRED)

# libpng 1.6's png.h no longer includes zlib.h; PNG.inl uses Z_BEST_SPEED from it.
set(forward "${CMAKE_BINARY_DIR}/vcpkg-forward")
file(WRITE "${forward}/PNG/png.h" "#include <zlib.h>\n#include <png.h>\n")
foreach(h jpeglib jerror jmorecfg)
    file(WRITE "${forward}/JPEG/${h}.h" "#include <${h}.h>\n")
endforeach()

foreach(tool PoissonRecon SurfaceTrimmer)
    add_executable(${tool} "${POISSONRECON_SOURCE}/Src/${tool}.cpp")
    target_include_directories(${tool} BEFORE PRIVATE "${forward}")
    target_compile_definitions(${tool} PRIVATE RELEASE NOMINMAX _CRT_SECURE_NO_WARNINGS)
    target_link_libraries(${tool} PRIVATE OpenMP::OpenMP_CXX PNG::PNG JPEG::JPEG ZLIB::ZLIB)
    if(MSVC)
        target_compile_options(${tool} PRIVATE /bigobj /EHsc)
        target_link_libraries(${tool} PRIVATE psapi)
    else()
        target_compile_options(${tool} PRIVATE -Wno-deprecated -Wno-invalid-offsetof -Wno-dangling-else)
    endif()
endforeach()

install(TARGETS PoissonRecon SurfaceTrimmer RUNTIME DESTINATION bin)
