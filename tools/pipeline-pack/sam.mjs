// The boundary model of the pipeline pack (M11 G12, ADR 0011): MobileSAM as a ready-made ONNX
// export (encoder and prompt decoder), fetched from pinned URLs into the build cache, refused
// unless each file's SHA-256 matches, and written to <pack>/models/sam/ with its model.json card.
// The app's **Suggest boundaries** and the Review mask assist read it there. Weights never enter
// git; the app never downloads anything.
//
// build.mjs calls installSam(); --no-sam leaves the model out.
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const EXPORT =
  'https://huggingface.co/PulpCut/mobilesam-onnx/resolve/1e774d8516a1e014803a6e06c749d144cea7b9be';

/** The shipped model: name, version, licence, where it comes from and its two pinned files. */
export const SAM_MODEL = Object.freeze({
  name: 'MobileSAM',
  version: '1.0',
  licence: 'Apache-2.0',
  source:
    'MobileSAM (https://github.com/ChaoningZhang/MobileSAM, Apache-2.0), ONNX export https://huggingface.co/PulpCut/mobilesam-onnx at 1e774d85',
  input: 'hwc-255',
  files: Object.freeze({
    'encoder.onnx': Object.freeze({
      url: `${EXPORT}/mobilesam.encoder.onnx`,
      size: 28_195_125,
      sha256: '4125037c5e24d6ea58e201b20e8d8fbbbd1135c0b881e34a8074b8c4f07e6918',
    }),
    'decoder.onnx': Object.freeze({
      url: `${EXPORT}/mobilesam.decoder.onnx`,
      size: 16_514_086,
      sha256: 'b0735abf07c7affddf20fffc3ce750f44af387ee6a7323880e909389ed15d279',
    }),
  }),
});

/** The `model.json` card the app reads (`segment.ts` `findSegmentModel`). */
export function samCard(model = SAM_MODEL) {
  return {
    name: model.name,
    version: model.version,
    licence: model.licence,
    source: model.source,
    input: model.input,
    sha256: Object.fromEntries(Object.entries(model.files).map(([f, v]) => [f, v.sha256])),
  };
}

const quiet = () => undefined;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * The model's files into `dest` (`<pack>/models/sam`), each from `cache` when it is there and
 * matches, else downloaded; a file whose SHA-256 differs from the pin is refused.
 */
export async function installSam({
  cache,
  dest,
  log = quiet,
  fetchImpl = fetch,
  model = SAM_MODEL,
}) {
  const dir = join(cache, 'sam');
  mkdirSync(dir, { recursive: true });
  mkdirSync(dest, { recursive: true });
  let bytes = 0;
  for (const [name, f] of Object.entries(model.files)) {
    const cached = join(dir, `${f.sha256}-${name}`);
    if (!existsSync(cached) || sha256(readFileSync(cached)) !== f.sha256) {
      log(`  downloading ${f.url}`);
      const res = await fetchImpl(f.url, {
        redirect: 'follow',
        headers: { 'User-Agent': 'quadrion-pipeline-pack' },
      });
      if (!res.ok) throw new Error(`${f.url}: HTTP ${String(res.status)}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const got = sha256(buf);
      if (got !== f.sha256)
        throw new Error(`${name} from ${f.url} has SHA-256 ${got}, expected ${f.sha256}`);
      writeFileSync(`${cached}.part`, buf);
      renameSync(`${cached}.part`, cached);
    }
    copyFileSync(cached, join(dest, name));
    bytes += f.size;
  }
  writeFileSync(join(dest, 'model.json'), `${JSON.stringify(samCard(model), null, 1)}\n`);
  log(
    `  boundary model: ${model.name} ${model.version} (${model.licence}), ${(bytes / 1e6).toFixed(1)} MB`,
  );
  return { dir: dest, bytes };
}
