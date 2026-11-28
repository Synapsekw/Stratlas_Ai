import { build } from "esbuild";
import { fileURLToPath } from "node:url";
await build({
  entryPoints: [fileURLToPath(new URL("./use-cases.js", import.meta.url))],
  bundle: true,
  format: "esm",
  outfile: fileURLToPath(
    new URL("../assets/use-cases/use-cases.bundle.js", import.meta.url),
  ),
  minify: true,
  target: "es2022",
});
console.log("Built the road, volumetric and facade previews.");
