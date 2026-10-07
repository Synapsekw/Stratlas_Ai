# OPF specification examples (test fixture)

These files are the `examples/` folder of the Open Photogrammetry Format specification,
copied unchanged except that the two Python helpers (`test_examples.py` and
`point_cloud/patch_invalid_partitioning.py`) are left out.

- Source: https://github.com/Pix4D/opf-spec, commit `57a736f5ac93f041c04fd2c9baf7560e6250cfb1` (8 Feb 2024)
- Copyright: Pix4D SA
- Licence: Creative Commons Attribution 4.0 International (CC-BY-4.0),
  https://creativecommons.org/licenses/by/4.0/

The examples illustrate the format; their values (camera ids, coordinates, the
`file:///c:/data/images/...` photo path) are Pix4D's example data, not client data and not
a real survey. `python/tests/test_opf.py` imports `project.opf` from here to check that
`opf.import` reads a specification-conformant project without failing, and that it never
follows the absolute photo path.
