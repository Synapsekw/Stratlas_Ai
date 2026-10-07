# Included by COLMAP's and pycolmap's project() (CMAKE_PROJECT_INCLUDE, M10 G1): refuse any LGPL
# part of Eigen at compile time. All of Eigen is MPL-2.0 since 3.4; this keeps it that way without
# replacing the compiler's default flags.
add_compile_definitions(EIGEN_MPL2_ONLY)
