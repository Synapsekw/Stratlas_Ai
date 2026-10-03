# Stratlas

Offline-first desktop app for fusing and reviewing drone reality capture of industrial assets: 3D models, point clouds, maps, orthomosaics, drone video with flight logs, photos and annotated issues in one scene and timeline, with AI agents in every window.

**Stratlas is a temporary working name** (see `packages/brand`).

## Layout

```
apps/desktop        Electron app (main, preload, renderer)
packages/schema     shared contracts (frozen v1)
packages/brand      product name and icons
packages/geo        CRS and project frame
packages/engine     three.js scene and layer adapters
packages/pointcloud point clouds
packages/maps       offline maps
packages/video      video and flight sync
packages/annotate   annotation suite and severity models
packages/ai         AI providers and agents
packages/ui         Mission design tokens and components
packages/project    project packages and importers
docs/               PRD, SPEC, ADRs, design direction, plans
```

Start with [docs/README.md](docs/README.md) and [CONTRIBUTING.md](CONTRIBUTING.md).
