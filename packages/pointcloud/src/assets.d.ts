/** Vite asset URL imports (the laz-perf WASM is bundled with the app, never fetched from a CDN). */
declare module '*.wasm?url' {
  const url: string;
  export default url;
}
