"""RF coverage prediction for telecom sites (``rf.coverage``, spec docs/superpowers/specs/2026-10-17-rf-coverage-design.md).

The maths here is the vectorised twin of ``packages/rf`` (TypeScript, the live preview). Both pass
the shared golden vectors in ``packages/rf/fixtures/golden/`` to 0.01 dB (spec D16):

- ``grid.py``: the study grid in the project CRS and the direction into the antenna frame (D15);
- ``pattern.py``: the 38.901 parametric pattern, two-cut MSI patterns and the MSI reader (D11);
- ``propagation.py``: 38.901 UMa, UMi, RMa, Okumura-Hata, COST-231 Hata and free space (D14);
- ``budget.py``: bands, resource blocks, margins, RSRP and classes (D13);
- ``inputs.py``: what the job reads (antenna file, sectors file, project catalogue);
- ``pipeline.py``: the job and its run folder (D12).
"""
