# pi-omlx

**OMLX inference stats for the [Pi coding agent](https://github.com/earendil-works) — model loading, prefill, generation, and tok/s, live in the working prompt and status bar.**

## Why pi-omlx

**Minimal** — Polls the built-in [omlx](https://github.com/jundot/omlx) stats endpoint while a turn is running and mirrors what the web UI shows into Pi's processing prompt. Each turn also leaves tokens in/out and elapsed time in the bottom status bar. No dependencies.

## Install

```bash
pi install git:github.com/gattjoe/pi-omlx
```

## What it does

While the agent is working, the processing prompt cycles through the current inference phase:

```sh
 ⠴ Loading model... (17.0% complete, 31.2s remaining, 3.4gb/25.4gb used)
 ⠼ Preparing... (91% cached, 6.4s queued, 30.1gb/35.6gb used)
 ⠼ Prefilling... (83.7% complete, 31.6s remaining, 22.7gb/25.1gb used)
 ⠸ Generating... (20.0 tok/s, 2.1s elapsed, 20.1gb/25.3gb used)
```

The status bar shows per-turn throughput, e.g. `↓20.5 tok/s (12.3s) | In: ↑410.2 tok/s (1.8s)`.

The memory figure uses omlx's hard limit, not the soft limit. This is not configurable at the moment.

## Configuration

If an API key is stored in Pi's auth storage under `omlx` it is used first — pi-omlx-picker is the recommended way to configure the omlx model and API key. Otherwise these env variables apply (defaults given):

```sh
# Omlx base url.
OMLX_BASE_URL="http://127.0.0.1:8000/v1"
# If you have set up an API key for the web ui, set it here.
OMLX_API_KEY=
```

## License

MIT
