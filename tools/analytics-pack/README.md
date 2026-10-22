# Analytics pack

The Analytics pack carries the local vision model for detectors: llama.cpp `llama-server` and Qwen2.5-VL-7B-Instruct (GGUF Q4_K_M plus its `mmproj`). It installs from an archive like the pipeline pack. Design: `docs/superpowers/specs/2026-10-17-local-vlm-detectors-design.md`.

## Pins

`lock.json` pins every download by URL, size and sha256:

- **Runtime:** llama.cpp `b11489` (published 2026-10-01), the Windows CUDA 13.4 x64 build and its matching `cudart` archive. It runs on the RTX 50 series (Blackwell) with driver 610.88. Windows x64 only in v1.
- **Model:** `ggml-org/Qwen2.5-VL-7B-Instruct-GGUF` at commit `508edd0a`: `Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf` and `mmproj-Qwen2.5-VL-7B-Instruct-f16.gguf`. Apache-2.0.

## Licence texts

The pack carries the licence of both components in `licences/`, each pinned in `lock.json` by URL, size and sha256 and listed in the manifest `files`:

- `licences/llama.cpp-LICENSE.txt`: the MIT licence, from the llama.cpp repository at tag `b11489`.
- `licences/Qwen2.5-VL-7B-Instruct-LICENSE.txt`: the Apache-2.0 text from Qwen's own repository (`QwenLM/Qwen2.5-VL`, pinned at commit `96588727`), because the model repositories on Hugging Face ship no LICENSE file. The model card declares Apache-2.0.

## Signing

When `QUADRION_PACK_SIGNING_KEY` names the publisher's private key (a PEM file kept offline, never in git), `build.mjs` writes `manifest.sig`, an Ed25519 signature of the exact `manifest.json` bytes, as the pipeline pack build does. The app checks it against `signing.pipelinePackKey` in brand.json. Without that key pinned, the app asks before it installs an unsigned pack.

## Smoke check

`smoke.py` starts the server as the app does: the pack's arguments, plus a random key per launch in the `LLAMA_API_KEY` environment variable (never on the command line). It then checks four things: a request without the key is refused with HTTP 401, boxes come back in the pixel frame of the sent image, yes/no logprobs score a clear case at or above 0.9 and an empty one at or below 0.1, and the logprobs have the shape the engine reads. `test_smoke.py` tests the key handling against a stub server (`uv run --project python pytest tools/analytics-pack/test_smoke.py`).

```bash
python tools/analytics-pack/smoke.py --server <dir>/llama-server.exe --model <model.gguf> --mmproj <mmproj.gguf>
```

Result on an RTX 5070 Ti (16 GB), 21 Oct 2026: `SMOKE OK`. The server was healthy in 4.1 s. The red square came back as `[899, 298, 1102, 503]` against `[900, 300, 1100, 500]` (3 px worst corner). P(yes) was 1.000 on the square and 0.026 on plain grey. A 1344 x 1008 image is about 1,750 prompt tokens, read in about 0.7 s, and generation ran at about 140 tokens per second. A second run on the same machine against the built pack (key in `LLAMA_API_KEY`) was also `SMOKE OK`, and the request without the key got HTTP 401.

Server notes from the run:

- `--no-webui` is deprecated in this release; the pack and the smoke check use `--no-ui`.
- With no API key the server allows any web origin (CORS). The app and the smoke check start it with a random key per launch in `LLAMA_API_KEY` (b11489's `--help` lists `--api-key` as `env: LLAMA_API_KEY`), so the key never shows in the process list. The app passes the key to the job through the state file, so a web page in a browser cannot call the server. The smoke check's 401 check fails if a later release stops reading that variable.
- Qwen-VL grounding wants at least 1,024 image tokens. The 1344 x 1008 tiles give about 1,700, so `--image-min-tokens` is not needed.
