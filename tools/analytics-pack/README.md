# Analytics pack

The Analytics pack carries the local vision model for detectors: llama.cpp `llama-server` and Qwen3.5-9B (GGUF Q4_K_M plus its `mmproj`). It installs from an archive like the pipeline pack. Version 0.2.0 (29 Oct 2026) swaps Qwen2.5-VL-7B for Qwen3.5-9B; its `appRange` floor is the app version read from `apps/desktop/package.json`. Design: `docs/superpowers/specs/2026-10-17-local-vlm-detectors-design.md`.

## Pins

`lock.json` pins every download by URL, size and sha256:

- **Runtime:** llama.cpp `b11489` (published 2026-10-01), the Windows CUDA 13.4 x64 build and its matching `cudart` archive. It runs on the RTX 50 series (Blackwell) with driver 610.88. Windows x64 only in v1.
- **Model:** `unsloth/Qwen3.5-9B-GGUF` at commit `3885219b`: `Qwen3.5-9B-Q4_K_M.gguf` (5,680,522,464 bytes) and `mmproj-F16.gguf` (918,166,080 bytes), stored in the pack as `model/qwen3.5-9b-q4_k_m.gguf` and `model/mmproj-qwen3.5-9b-f16.gguf`. Apache-2.0. Both hashes match the files the VLM bench ran (Hugging Face LFS `oid`).

## Licence texts

The pack carries the licence of both components in `licences/`, each pinned in `lock.json` by URL, size and sha256 and listed in the manifest `files`:

- `licences/llama.cpp-LICENSE.txt`: the MIT licence, from the llama.cpp repository at tag `b11489`.
- `licences/Qwen3.5-9B-LICENSE.txt`: the Apache-2.0 text from Qwen's own repository (`QwenLM/Qwen3.5`, pinned at commit `2ea10dc7`), because the model repository on Hugging Face ships no LICENSE file. The model card declares Apache-2.0.

## Signing

When `QUADRION_PACK_SIGNING_KEY` names the publisher's private key (a PEM file kept offline, never in git), `build.mjs` writes `manifest.sig`, an Ed25519 signature of the exact `manifest.json` bytes, as the pipeline pack build does. The app checks it against `signing.pipelinePackKey` in brand.json. Without that key pinned, the app asks before it installs an unsigned pack.

## Smoke check

`smoke.py` starts the server as the app does: the pack's arguments, plus a random key per launch in the `LLAMA_API_KEY` environment variable (never on the command line). It then checks four things: a request without the key is refused with HTTP 401, the red square comes back in the model's box frame (0 to 1000 for Qwen3.5, within 3 %), yes/no logprobs score a clear case at or above 0.9 and an empty one at or below 0.1, and the logprobs have the shape the engine reads. `test_smoke.py` tests the key handling against a stub server (`uv run --project python pytest tools/analytics-pack/test_smoke.py`).

```bash
python tools/analytics-pack/smoke.py --server <dir>/llama-server.exe --model <model.gguf> --mmproj <mmproj.gguf> --model-id qwen3.5-9b-q4_k_m
```

Result for pack 0.2.0 (Qwen3.5-9B) on an RTX 5070 Ti (16 GB), 29 Oct 2026, against the built pack: `SMOKE OK`. The server was healthy in 18.6 s (first start, model read from a cold file cache). The request without the key got HTTP 401. The red square at `[900, 300, 1100, 500]` in a 1344 x 1008 image came back as `[675, 296, 828, 496]` in the 0 to 1000 frame (expected about `[670, 298, 818, 496]`; worst corner 9.5 thousandths off, inside the 3 % check), in 1.2 s. P(yes) was 0.999 on the square and 0.000 on plain grey (1.4 s), and the logprobs had the shape the engine reads. The archive is 6.89 GB (`analytics-pack-0.2.0-win-x64.tar.gz`).

Corrosion detector on Qwen3.5-9B (29 Oct 2026, unchanged detector text, threshold 0.8, `bench.py` with the first 50 photos of each split): no go, so the detector stays experimental and tuned on the old model. The reviewed rust truth inside those photos is too thin to measure recall (tune split: 1 truth item across three reference projects, 0 found; bench split: 0 truth items). False drafts were low on two projects (0.06 and 0.12 per photo) and 0.54 (tune) and 0.48 (bench) per photo on the chimney project, where every draft was unmatched.

Result for pack 0.1.0 (Qwen2.5-VL-7B) on an RTX 5070 Ti (16 GB), 21 Oct 2026: `SMOKE OK`. The server was healthy in 4.1 s. The red square came back as `[899, 298, 1102, 503]` against `[900, 300, 1100, 500]` (3 px worst corner). P(yes) was 1.000 on the square and 0.026 on plain grey. A 1344 x 1008 image is about 1,750 prompt tokens, read in about 0.7 s, and generation ran at about 140 tokens per second. A second run on the same machine against the built pack (key in `LLAMA_API_KEY`) was also `SMOKE OK`, and the request without the key got HTTP 401.

Server notes from the run:

- `--no-webui` is deprecated in this release; the pack and the smoke check use `--no-ui`.
- With no API key the server allows any web origin (CORS). The app and the smoke check start it with a random key per launch in `LLAMA_API_KEY` (b11489's `--help` lists `--api-key` as `env: LLAMA_API_KEY`), so the key never shows in the process list. The app passes the key to the job through the state file, so a web page in a browser cannot call the server. The smoke check's 401 check fails if a later release stops reading that variable.
- Qwen-VL grounding wants at least 1,024 image tokens. The 1344 x 1008 tiles give about 1,700, so `--image-min-tokens` is not needed.
- Qwen3.5 thinks by default. The server starts with `--reasoning off` (the smoke check does the same for a Qwen3 model id) and each request sends `chat_template_kwargs.enable_thinking: false`.
- Qwen3 models answer `bbox_2d` in a 0 to 1000 frame of the image, not in sent pixels (the `detect.vlm` engine picks the frame from `params.model`).
- VRAM: about 6.8 GB at an 8k context (the bench's peak); the app asks for 7,400 MB free.
- At 1344 px the long edge gives enough image tokens, so `--image-min-tokens` is still not needed.
