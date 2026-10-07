// The deep import of 3DTilesRendererJS's glTF plugin (adapter.ts) takes its types from the typed
// plugins entry; the package maps `src/*` types to `*.d.ts`, which a `.js` path does not match.
declare module '3d-tiles-renderer/src/three/plugins/GLTFExtensionsPlugin.js' {
  export { GLTFExtensionsPlugin } from '3d-tiles-renderer/plugins';
}
