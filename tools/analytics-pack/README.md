# Analytics pack

The Analytics pack carries the local vision model for detectors: llama.cpp `llama-server` and Qwen2.5-VL-7B-Instruct (GGUF Q4_K_M plus its `mmproj`). It installs from an archive like the pipeline pack. Design: `docs/superpowers/specs/2026-10-17-local-vlm-detectors-design.md`.

## Pins

`lock.json` pins every download by URL, size and sha256:

- **Runtime:** llama.cpp `b11489` (published 2026-10-01), the Windows CUDA 13.4 x64 build and its matching `cudart` archive. It runs on the RTX 50 series (Blackwell) with driver 610.88. Windows x64 only in v1.
- **Model:** `ggml-org/Qwen2.5-VL-7B-Instruct-GGUF` at commit `508edd0a`: `Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf` and `mmproj-Qwen2.5-VL-7B-Instruct-f16.gguf`. Apache-2.0.

## Smoke check

`smoke.py` starts the server with the pack's arguments and checks three things: boxes come back in the pixel frame of the sent image, yes/no logprobs score a clear case at or above 0.9 and an empty one at or below 0.1, and the logprobs have the shape the engine reads.

```bash
python tools/analytics-pack/smoke.py --server <dir>/llama-server.exe --model <model.gguf> --mmproj <mmproj.gguf>
```

Result on an RTX 5070 Ti (16 GB), 21 Oct 2026: `SMOKE OK`. The server was healthy in 4.1 s. The red square came back as `[899, 298, 1102, 503]` against `[900, 300, 1100, 500]` (3 px worst corner). P(yes) was 1.000 on the square and 0.026 on plain grey. A 1344 x 1008 image is about 1,750 prompt tokens, read in about 0.7 s, and generation ran at about 140 tokens per second.

Server notes from the run:

- `--no-webui` is deprecated in this release; the pack and the smoke check use `--no-ui`.
- With no API key the server allows any web origin (CORS). The pack and the smoke check start it with a random `--api-key` per launch, passed to the job through the state file, so a web page in a browser cannot call it.
- Qwen-VL grounding wants at least 1,024 image tokens. The 1344 x 1008 tiles give about 1,700, so `--image-min-tokens` is not needed.
