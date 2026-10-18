# Source-driven detail refinement

Continuation of the approved engineering-fidelity design and task 7. All changes stay on
`codex/engineering-fidelity`; no integration into main. UI Fix/d-ba notified again by message
`a2be824f-1a18-44d5-bc8f-297a10a57965`. Existing live approval has finished; this iteration uses
local source processing and replays the saved proposal without another provider request.

1. Add regression fixtures for roof profiles, climbing steps and tilt-aware mounting hardware.
   Extend backwards-compatible observation/assembly parameters for source-fitted roof surfaces
   and climbing routes. Preserve the measured device transforms and source frame.
2. Fit roof slopes/ridges and climbing route from source points using bounded generic algorithms.
   Keep unsupported construction details explicitly inferred. Test rotated/translated fixtures,
   plain roofs and shafts without climbing hardware; reject unsupported fits.
3. Build plates/clamps and multi-cable service routes from measured device/pipe endpoints;
   add profiled roof sheets and step hardware. Preserve stable selectable assembly identities.
4. Rebuild the private benchmark in a versioned local output directory using the shipping assembler/builders.
   Validate geometry, ownership, fixed-frame alignment and height. Render identical cameras
   against the reference, inspect and refine. Show new actual-app selection and overlay proof.
5. Run focused regression suites, typecheck/build and fresh code review. Record remaining
   measured discrepancies honestly. No merge, push or changes in main.

The shared GLB/review/coordinates framework supports multiple families, but detailed automatic
reconstruction is family-specific. This is not a universal arbitrary-asset engineering builder.
