# Stratlas pipeline pack, macOS arm64 (M10 G1): static libraries, release only, macOS 14 and later
# (the pack's photogrammetry platforms, decision 8). BLAS and LAPACK come from Accelerate.
set(VCPKG_TARGET_ARCHITECTURE arm64)
set(VCPKG_CRT_LINKAGE dynamic)
set(VCPKG_LIBRARY_LINKAGE static)
set(VCPKG_CMAKE_SYSTEM_NAME Darwin)
set(VCPKG_OSX_ARCHITECTURES arm64)
set(VCPKG_OSX_DEPLOYMENT_TARGET 14.0)
set(VCPKG_BUILD_TYPE release)

# PDAL only builds as a shared library (its port says ONLY_DYNAMIC_LIBRARY); its dependencies stay static.
if(PORT STREQUAL "pdal")
    set(VCPKG_LIBRARY_LINKAGE dynamic)
endif()

# Eigen: refuse any LGPL part at compile time (all of Eigen is MPL-2.0 since 3.4; this keeps it so).
set(VCPKG_C_FLAGS "")
set(VCPKG_CXX_FLAGS "-DEIGEN_MPL2_ONLY")
