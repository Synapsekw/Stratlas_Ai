# PoissonRecon and SurfaceTrimmer (M10 G1 for G3's photo/mesh.py), from mkazhdan/PoissonRecon
# (MIT) at the commit components.json pins. Upstream builds with a Makefile (Linux) and Visual
# Studio projects; this one CMake project builds the two tools the pack needs on Windows and macOS
# from the same sources: the vendored zlib (Zlib), libpng (libpng licence) and IJG JPEG (IJG) as
# static libraries, each with the source list of upstream's own .vcxproj, so a new upstream
# commit needs no change here.
#
#   cmake -S tools/pipeline-pack/native/poissonrecon -B <build> -DPOISSONRECON_SOURCE=<checkout>
cmake_minimum_required(VERSION 3.21)
project(StratlasPoissonRecon C CXX)

if(NOT POISSONRECON_SOURCE OR NOT EXISTS "${POISSONRECON_SOURCE}/Src/PoissonRecon.cpp")
    message(FATAL_ERROR "Set POISSONRECON_SOURCE to a PoissonRecon checkout")
endif()
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
find_package(OpenMP REQUIRED COMPONENTS CXX)

# The ClCompile items of one of upstream's Visual Studio projects, as absolute paths.
function(vcxproj_sources out project)
    file(STRINGS "${POISSONRECON_SOURCE}/${project}" lines REGEX "ClCompile Include=")
    set(files "")
    foreach(line IN LISTS lines)
        string(REGEX REPLACE ".*ClCompile Include=\"([^\"]+)\".*" "\\1" f "${line}")
        string(REPLACE "\\" "/" f "${f}")
        list(APPEND files "${POISSONRECON_SOURCE}/${f}")
    endforeach()
    set(${out} ${files} PARENT_SCOPE)
endfunction()

foreach(lib ZLIB PNG JPEG)
    vcxproj_sources(srcs ${lib}.vcxproj)
    # Programs that upstream compiles into its Windows libraries but never calls.
    list(FILTER srcs EXCLUDE REGEX "/(pngtest|ckconfig)\\.c(pp)?$")
    # The vendored IJG JPEG files are named .cpp but are C, and the tools call them as C.
    set_source_files_properties(${srcs} PROPERTIES LANGUAGE C)
    add_library(pr_${lib} STATIC ${srcs})
    target_include_directories(pr_${lib} PUBLIC "${POISSONRECON_SOURCE}" "${POISSONRECON_SOURCE}/${lib}")
    target_compile_definitions(pr_${lib} PRIVATE _CRT_SECURE_NO_DEPRECATE _CRT_SECURE_NO_WARNINGS)
    if(NOT MSVC)
        target_compile_options(pr_${lib} PRIVATE -w)
    endif()
endforeach()
target_link_libraries(pr_PNG PUBLIC pr_ZLIB)

foreach(tool PoissonRecon SurfaceTrimmer)
    add_executable(${tool} "${POISSONRECON_SOURCE}/Src/${tool}.cpp")
    target_include_directories(${tool} PRIVATE "${POISSONRECON_SOURCE}" "${POISSONRECON_SOURCE}/JPEG")
    target_compile_definitions(${tool} PRIVATE RELEASE NOMINMAX _CRT_SECURE_NO_WARNINGS)
    target_link_libraries(${tool} PRIVATE OpenMP::OpenMP_CXX pr_PNG pr_JPEG pr_ZLIB)
    if(MSVC)
        target_compile_options(${tool} PRIVATE /bigobj /EHsc)
        target_link_libraries(${tool} PRIVATE psapi)
    else()
        target_compile_options(${tool} PRIVATE -Wno-deprecated -Wno-invalid-offsetof -Wno-dangling-else)
    endif()
endforeach()

install(TARGETS PoissonRecon SurfaceTrimmer RUNTIME DESTINATION bin)
