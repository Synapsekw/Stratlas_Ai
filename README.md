# Quadrion AI

Offline-first desktop app for fusing and reviewing drone reality capture of industrial assets: 3D models, point clouds, maps, orthomosaics, drone video with flight logs, photos and annotated issues in one scene and timeline, with AI agents in every window. Windows only for now (macOS is parked).

_Four dimensions. One view._ The product was called Stratlas until 7 Oct 2026; identity lives in `packages/brand`, the brand kit in `docs/brand/quadrion/kit/`.

## Layout

```
apps/desktop          Electron app (main, preload, renderer)
apps/team-server      self-hosted Team Server (preview)
packages/schema       shared contracts (frozen v1)
packages/brand        product name and icons
packages/geo          CRS and project frame
packages/engine       three.js scene and layer adapters
packages/pointcloud   point clouds
packages/maps         offline map packs and online imagery
packages/globe        the Globe (CesiumJS)
packages/tiles        3D Tiles in the site view
packages/video        video and flight sync
packages/annotate     annotation suite and severity models
packages/change       change between capture dates
packages/modelling    models from drawings and point clouds
packages/survey       surveying: measurements, sections, templates
packages/volumetric   stockpiles, volumes, cut and fill
packages/rf           RF coverage prediction
packages/ai           AI providers and agents
packages/ui           Mission design tokens and components
packages/workspace    renderer-side shared state
packages/project      project packages and importers
packages/journal      project journal and signing
packages/merge        merge engine for collaboration
packages/sync         exchange files, hub folders, HTTP client
packages/collab       multi-reviewer workflow
python/               processing pipelines, shipped as the pipeline pack (photogrammetry via OpenDroneMap 3.6.2)
tools/                build, release, CI and session scripts
docs/                 PRD, SPEC, ADRs, user guide, design direction, plans
```

Start with [docs/README.md](docs/README.md) and [CONTRIBUTING.md](CONTRIBUTING.md).
