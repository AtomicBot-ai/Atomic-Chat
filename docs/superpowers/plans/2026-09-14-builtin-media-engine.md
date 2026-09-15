# Built-in media engine and the image provider choice

**Tracker:** Task 30 (supersedes Task 26's "get ComfyUI running" as the way Media works out of the box). Decisions D39 (built-in engine), D40 (provider choice).

## Why

The user's plan was for Radium to be self-contained. The Media page is not. It has no engine of its own and only talks to:
- a Radium Media Worker that is not in this repository, not published and not installed;
- ComfyUI, which the user must install;
- paid online services.

Chat is self-contained because Radium ships llama.cpp and downloads models for it. Media should work the same way.

The user's requirements (2026-09-14):
- "build it": a built-in engine, so installing Radium is all you need.
- "i still want the option to connect to comfyUI and the cloud and the local option ... Something like image processing provider with a drop down menu listing those providers I just listed and any other ones we can roll up into this".
- "we need CUDA and Nvidia for when I get back to my dual 3090 desktop".

## What gets built

1. **Built-in engine.** [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) (MIT) is the image and video counterpart of llama.cpp.
   - Radium downloads the build that suits the computer:
     - CUDA for NVIDIA;
     - Vulkan for AMD, Intel and other GPUs;
     - CPU as the fallback.
   - Builds are pinned to a reviewed release and checked against its published SHA-256 before use.
2. **Built-in model catalog.** Models the engine runs, each with its size, licence, source, SHA-256 and the hardware it needs:
   - Stable Diffusion 1.5 first;
   - then SDXL, SD3, Flux and Wan 2.x as the engine and hardware allow.
   - Downloads show progress and can be cancelled.
3. **Built-in provider.** A `builtin-engine` adapter implements the media contract and passes the shared conformance suite unmodified:
   - health: is the engine installed, and on which device;
   - capabilities: the catalog with its install state;
   - submit, poll and cancel;
   - model install.
   - Each job runs the engine as its own process: progress is read from its output, cancel stops the process, and the image is written into Radium's media folder.
   - It becomes the first provider for new users; the existing providers stay.
4. **Image provider choice.**
   - The Media page gets an "Image provider" drop-down listing every enabled provider (Built-in, ComfyUI, cloud, and so on).
   - Settings > Media lists and adds providers.
5. **More providers**, one adapter each, after the above:
   - Automatic1111 / Forge WebUI;
   - Stability AI;
   - Replicate;
   - fal.ai.
6. **NVIDIA.**
   - The CUDA build is chosen when an NVIDIA GPU is found; its CUDA runtime is downloaded only then.
   - Each job runs on one GPU; with two GPUs, two jobs can run side by side.
   - Splitting one job across two GPUs is tested on the dual-3090 desktop before it is promised.

## Order, each step tests first

| Step | What | Where |
|---|---|---|
| S01 | Proof on this PC: the pinned Vulkan build generates one SD 1.5 image; record time and memory | This PC |
| S02 | Engine variants: choose CUDA / Vulkan / CPU from detected GPUs; pinned release manifest with SHA-256 | Laptop |
| S03 | Engine install: download, verify, unpack into `<data>/media/engine/<release>/<variant>`, refuse a bad checksum | Laptop |
| S04 | Model catalog and model install with progress, cancel and checksum | Laptop |
| S05 | Engine server: run the engine's `sd-server` privately on 127.0.0.1 for the chosen model (start options from the model's files, video memory-saving options, a free port; refuse a model not fully downloaded), supervise the process (ready check, stop on switch and on exit, startup reaper), and read step progress from its output. Jobs go to its native async API (`/sdcpp/v1/img_gen`, `/vid_gen`, `/jobs/{id}`, `/jobs/{id}/cancel`); results come back as base64 images. Chosen over one engine run per image because the model stays loaded and the API already gives queue, status and cancel. | Laptop |
| S06 | `builtin-engine` adapter + conformance suite; baseline provider for new users | Laptop |
| S07 | Image provider drop-down on the Media page; Settings lists the built-in provider first | Laptop |
| S08 | First image from the Media page on this PC (end to end) | This PC |
| S09 | Automatic1111 / Forge adapter | Laptop |
| S10 | Stability AI, Replicate and fal.ai adapters | Laptop |
| S11 | CUDA on the dual-3090 desktop: install, generate, two jobs on two GPUs | Desktop |
| S12 | Verify, commit, PR, version-bumped test build, fork features register rows | Laptop |

## Rules carried over

- **Tests first.** Every step starts with a test seen failing for the right reason.
- **Checks match the build.** Web: `tsc -b`, lint, vitest and test-quality. Rust: tests, clippy and rustfmt. Hardening contracts and the selective media guard also run.
- **Downloads.** Pinned versions and published checksums; nothing runs unverified. Model licences are shown before download.
- **No new always-on process.** The engine only runs while a job runs.
- **Existing providers keep working** and keep passing the conformance suite.
- **Every build handed to the user gets a new version** (D34).
