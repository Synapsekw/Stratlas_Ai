# Stratlas pipeline pack, Windows x64 (M10 G1): static libraries with the dynamic CRT, release only.
# Static linking keeps the wheels free of extra DLLs and makes vcpkg's `lapack` choose CLAPACK
# (f2c, no gfortran runtime) instead of lapack-reference. Nothing LGPL is built (the native
# licence gate refuses an LGPL port that is not a shared library).
set(VCPKG_TARGET_ARCHITECTURE x64)
set(VCPKG_CRT_LINKAGE dynamic)
set(VCPKG_LIBRARY_LINKAGE static)
set(VCPKG_BUILD_TYPE release)

# PDAL only builds as a DLL (its port says ONLY_DYNAMIC_LIBRARY); its dependencies stay static.
if(PORT STREQUAL "pdal")
    set(VCPKG_LIBRARY_LINKAGE dynamic)
endif()

# Eigen: refuse any LGPL part at compile time (all of Eigen is MPL-2.0 since 3.4; this keeps it so).
set(VCPKG_C_FLAGS "")
set(VCPKG_CXX_FLAGS "-DEIGEN_MPL2_ONLY")
