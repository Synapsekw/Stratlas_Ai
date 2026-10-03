# ADR 0002: Mission UI direction

- Status: Accepted, 2026-10-03
- Deciders: founder

## Context

Round 1 (Console, Workbench, Canvas) was rejected. Round 2 tried three directions on real data: Mission (Palantir Gotham / Anduril Lattice), Flight (DJI FlightHub 2 / Terra) and Studio (Unreal Engine 5 / Blender 4).

## Decision

Build Stratlas in the Mission direction, as specified in [docs/design/DIRECTION.md](../../design/DIRECTION.md), with the round 2 Mission mockup as the reference build and its tokens as the seed for `packages/ui`.

## Consequences

- The UI stream (S2) can start from the Mission CSS tokens and layout.
- Customer presentation and team editing use the same direction; editing affordances (keyframes, graphs) are added inside Mission's timeline rather than as a separate editor layout.
- Fonts (IBM Plex family, SIL OFL) ship inside the app.
