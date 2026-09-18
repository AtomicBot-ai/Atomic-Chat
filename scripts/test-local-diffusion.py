#!/usr/bin/env python3
"""Opt-in live contract test for the pinned stable-diffusion.cpp server.

Two layers, both gated on environment variables so `make verify` never
touches the network or a GPU:

1. ``ATOMIC_LIVE_SDCPP_DIR`` — a directory holding ``sd-server`` / ``sd-cli``
   (the unpacked archive from ``backends/sdcpp-manifest.json``). The binary's
   ``--help`` must identify itself as stable-diffusion.cpp and list every flag
   in ``tests/fixtures/sdcpp/required-flags.txt``; a flag renamed upstream
   fails here instead of at a user's first generation.
2. ``ATOMIC_LIVE_SDCPP_MODEL`` (+ ``ATOMIC_LIVE_SDCPP_VAE`` and one of
   ``ATOMIC_LIVE_SDCPP_LLM`` / ``ATOMIC_LIVE_SDCPP_QWEN2VL`` /
   ``ATOMIC_LIVE_SDCPP_CLIP_L`` + ``ATOMIC_LIVE_SDCPP_T5XXL``) — a checkpoint
   set. The server is started with the exact flag set the plugin uses, the job
   API is driven end to end (capabilities, ``img_gen`` submit, poll to
   ``completed``, PNG decode), and the verbose stdout is checked for the
   ``N/M`` step lines the plugin's progress parser relies on.

Everything else is reported as a skip; ``--require`` turns skips into failures.
"""

from __future__ import annotations

import argparse
import base64
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from live_test_support import LiveTestError, json_request, unused_local_port

ROOT = Path(__file__).resolve().parents[1]
REQUIRED_FLAGS = ROOT / "tests" / "fixtures" / "sdcpp" / "required-flags.txt"
STEP_RE = re.compile(r"(\d+)\s*/\s*(\d+)")
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def binary(dir_path: Path, name: str) -> Path:
    candidate = dir_path / (f"{name}.exe" if sys.platform == "win32" else name)
    if not candidate.exists():
        raise LiveTestError(f"{candidate} does not exist")
    return candidate


def child_env(dir_path: Path) -> dict[str, str]:
    env = dict(os.environ)
    key = {"darwin": "DYLD_LIBRARY_PATH", "win32": "PATH"}.get(sys.platform, "LD_LIBRARY_PATH")
    env[key] = os.pathsep.join(filter(None, [str(dir_path), env.get(key, "")]))
    return env


def check_help(dir_path: Path) -> None:
    server = binary(dir_path, "sd-server")
    result = subprocess.run(
        [str(server), "--help"],
        capture_output=True,
        text=True,
        timeout=30,
        env=child_env(dir_path),
    )
    text = result.stdout + result.stderr
    if "stable-diffusion.cpp" not in text:
        raise LiveTestError("sd-server --help does not identify as stable-diffusion.cpp")
    required = [
        line.strip()
        for line in REQUIRED_FLAGS.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.startswith("#")
    ]
    missing = [flag for flag in required if flag not in text]
    if missing:
        raise LiveTestError(f"sd-server --help lacks flags: {', '.join(missing)}")
    print(f"ok   help: {len(required)} required flags present")


def server_args(port: int, scratch: Path) -> list[str]:
    """Mirror `build_server_args` in the plugin: model flags, listen, scratch
    dirs, speed flags, macOS text encoder on CPU, verbose."""
    args = ["--diffusion-model", os.environ["ATOMIC_LIVE_SDCPP_MODEL"]]
    for env_key, flag in (
        ("ATOMIC_LIVE_SDCPP_VAE", "--vae"),
        ("ATOMIC_LIVE_SDCPP_CLIP_L", "--clip_l"),
        ("ATOMIC_LIVE_SDCPP_T5XXL", "--t5xxl"),
        ("ATOMIC_LIVE_SDCPP_LLM", "--llm"),
        ("ATOMIC_LIVE_SDCPP_QWEN2VL", "--qwen2vl"),
    ):
        value = os.environ.get(env_key)
        if value:
            args += [flag, value]
    vae_format = os.environ.get("ATOMIC_LIVE_SDCPP_VAE_FORMAT")
    if vae_format:
        args += ["--vae-format", vae_format]
    args += ["--listen-ip", "127.0.0.1", "--listen-port", str(port)]
    args += ["--lora-model-dir", str(scratch), "--hires-upscalers-dir", str(scratch), "--embd-dir", str(scratch)]
    args += ["--diffusion-fa", "--diffusion-conv-direct"]
    if os.environ.get("ATOMIC_LIVE_SDCPP_OFFLOAD") == "1":
        args += ["--offload-to-cpu"]
    if sys.platform == "darwin":
        args += ["--clip-on-cpu"]
    args += ["-v"]
    return args


def wait_ready(base_url: str, process: subprocess.Popen[str], timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise LiveTestError(f"sd-server exited during load with code {process.returncode}")
        try:
            status, _ = json_request(f"{base_url}/v1/models", timeout=2)
            if status == 200:
                return
        except Exception:  # noqa: BLE001 - not listening yet
            pass
        time.sleep(0.5)
    raise LiveTestError(f"sd-server did not become ready within {timeout}s")


def run_generation(dir_path: Path, startup_timeout: float, generate_timeout: float) -> None:
    server = binary(dir_path, "sd-server")
    port = unused_local_port()
    base_url = f"http://127.0.0.1:{port}"
    with tempfile.TemporaryDirectory(prefix="atomic-sdcpp-") as tmp:
        scratch = Path(tmp) / "scratch"
        scratch.mkdir()
        log_path = Path(tmp) / "sd-server.log"
        with open(log_path, "w", encoding="utf-8") as log:
            process = subprocess.Popen(
                [str(server), *server_args(port, scratch)],
                stdout=log,
                stderr=subprocess.STDOUT,
                text=True,
                env=child_env(dir_path),
            )
            try:
                started = time.monotonic()
                wait_ready(base_url, process, startup_timeout)
                print(f"ok   ready after {time.monotonic() - started:.1f}s")

                status, caps = json_request(f"{base_url}/sdcpp/v1/capabilities", timeout=10)
                if status != 200 or not isinstance(caps, dict):
                    raise LiveTestError(f"capabilities returned HTTP {status}: {caps!r}")
                modes = caps.get("supported_modes")
                if not isinstance(modes, list) or "img_gen" not in modes:
                    raise LiveTestError(f"capabilities do not advertise img_gen: {modes!r}")
                cancel = caps.get("features_by_mode", {}).get("img_gen", {}).get("cancel_generating")
                print(f"ok   capabilities: modes={modes} cancel_generating={cancel!r}")

                body: dict[str, Any] = {
                    "prompt": "a small red cube on a white table, studio photo",
                    "negative_prompt": "",
                    "width": 256,
                    "height": 256,
                    "batch_count": 1,
                    "output_format": "png",
                    "seed": 42,
                    "sample_params": {"sample_steps": 4, "guidance": {"txt_cfg": 1.0}},
                }
                status, submitted = json_request(f"{base_url}/sdcpp/v1/img_gen", method="POST", body=body, timeout=30)
                if status != 202 or not isinstance(submitted, dict) or "id" not in submitted:
                    raise LiveTestError(f"img_gen returned HTTP {status}: {submitted!r}")
                job_id = submitted["id"]
                print(f"ok   submitted job {job_id} ({submitted.get('status')})")

                deadline = time.monotonic() + generate_timeout
                job: dict[str, Any] = {}
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        raise LiveTestError(f"sd-server died mid-job with code {process.returncode}")
                    status, job = json_request(f"{base_url}/sdcpp/v1/jobs/{job_id}", timeout=10)
                    if status != 200 or not isinstance(job, dict):
                        raise LiveTestError(f"job poll returned HTTP {status}: {job!r}")
                    if job.get("status") in {"completed", "failed", "cancelled"}:
                        break
                    time.sleep(0.4)
                if job.get("status") != "completed":
                    raise LiveTestError(f"job ended as {job.get('status')!r}: {job.get('error')!r}")
                images = (job.get("result") or {}).get("images") or []
                if not images or "b64_json" not in images[0]:
                    raise LiveTestError(f"completed job carries no images: {job.get('result')!r}")
                png = base64.b64decode(images[0]["b64_json"])
                if not png.startswith(PNG_MAGIC):
                    raise LiveTestError("decoded image is not a PNG")
                print(f"ok   completed: {len(images)} image(s), {len(png)} bytes PNG")
            finally:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
        log_text = log_path.read_text(encoding="utf-8", errors="replace")
        steps = [m for m in STEP_RE.finditer(log_text) if m.group(2) == "4"]
        if not steps:
            raise LiveTestError("verbose stdout carried no 'N/4' step lines; the progress parser would be blind")
        print(f"ok   progress: {len(steps)} step records for 4 sampling steps")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--require", action="store_true", help="fail instead of skipping when unset")
    parser.add_argument("--startup-timeout", type=float, default=float(os.environ.get("ATOMIC_LIVE_SDCPP_STARTUP_TIMEOUT", "600")))
    parser.add_argument("--generate-timeout", type=float, default=float(os.environ.get("ATOMIC_LIVE_SDCPP_GENERATE_TIMEOUT", "1800")))
    args = parser.parse_args()

    dir_value = os.environ.get("ATOMIC_LIVE_SDCPP_DIR")
    if not dir_value:
        message = "sdcpp: missing ATOMIC_LIVE_SDCPP_DIR"
        if args.require:
            print(f"FAIL {message}", file=sys.stderr)
            return 1
        print(f"skip {message}")
        return 0
    dir_path = Path(dir_value).expanduser()
    try:
        check_help(dir_path)
        if os.environ.get("ATOMIC_LIVE_SDCPP_MODEL"):
            run_generation(dir_path, args.startup_timeout, args.generate_timeout)
        else:
            message = "sdcpp generation: missing ATOMIC_LIVE_SDCPP_MODEL"
            if args.require:
                print(f"FAIL {message}", file=sys.stderr)
                return 1
            print(f"skip {message}")
    except LiveTestError as error:
        print(f"FAIL sdcpp: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
