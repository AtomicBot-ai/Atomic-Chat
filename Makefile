# Makefile for Atomic Chat Electron App - Build, Lint, Test, and Clean

REPORT_PORTAL_URL ?= ""
REPORT_PORTAL_API_KEY ?= ""
REPORT_PORTAL_PROJECT_NAME ?= ""
	REPORT_PORTAL_LAUNCH_NAME ?= "Atomic Chat App"
REPORT_PORTAL_DESCRIPTION ?= "Atomic Chat App report"

# Default target, does nothing
all:
	@echo "Specify a target to run"

# Installs yarn dependencies and builds core and extensions
install-and-build:
ifeq ($(OS),Windows_NT)
	echo "skip"
else ifeq ($(shell uname -s),Linux)
	chmod +x src-tauri/build-utils/*
endif
	yarn install
	yarn build:tauri:plugin:api
	yarn build:core
	yarn build:extensions

# Install required Rust targets for macOS universal builds
install-rust-targets:
ifeq ($(shell uname -s),Darwin)
	@echo "Detected macOS, installing universal build targets..."
	rustup target add x86_64-apple-darwin
	rustup target add aarch64-apple-darwin
	@echo "Rust targets installed successfully!"
else
	@echo "Not macOS; skipping Rust target installation."
endif

# Install required Rust targets for Android builds
install-android-rust-targets:
	@echo "Checking and installing Android Rust targets..."
	@rustup target list --installed | grep -q "aarch64-linux-android" || rustup target add aarch64-linux-android
	@rustup target list --installed | grep -q "armv7-linux-androideabi" || rustup target add armv7-linux-androideabi
	@rustup target list --installed | grep -q "i686-linux-android" || rustup target add i686-linux-android
	@rustup target list --installed | grep -q "x86_64-linux-android" || rustup target add x86_64-linux-android
	@echo "Android Rust targets ready!"

# Install required Rust targets for iOS builds
install-ios-rust-targets:
	@echo "Checking and installing iOS Rust targets..."
	@rustup target list --installed | grep -q "aarch64-apple-ios" || rustup target add aarch64-apple-ios
	@rustup target list --installed | grep -q "aarch64-apple-ios-sim" || rustup target add aarch64-apple-ios-sim
	@rustup target list --installed | grep -q "x86_64-apple-ios" || rustup target add x86_64-apple-ios
	@echo "iOS Rust targets ready!"

# Download the pinned cloudflared sidecar (Settings → Remote & LAN) into
# src-tauri/resources/bin, verified by sha256. Only downloads when it has to:
# a verified install already in place is left alone, and a verified archive in
# scripts/dist is reused offline. Version and hashes: scripts/download-bin.mjs.
#
# Every dev target below gets this for free: `yarn download:bin`, their first
# step, runs the same install, so `make dev` on a checkout that has no
# cloudflared yet fetches it before Tauri looks for the externalBin.
download-cloudflared:
	yarn download:cloudflared

dev: install-and-build
	yarn download:bin
	make download-llamacpp-backend
	make download-llamacpp-upstream-backend
	make build-mlx-server
	make build-foundation-models-server-if-exists
	make build-cli-dev
	yarn dev

# Same as `dev`, but skips (re)installing backends if they are already present.
# Uses the `-if-exists` targets for llamacpp / mlx-server / foundation-models-server.
dev-fast: install-and-build
	yarn download:bin
	make download-llamacpp-backend-if-exists
	make download-llamacpp-upstream-backend-if-exists
	make build-mlx-server-if-exists
	make build-foundation-models-server-if-exists
	make build-cli-dev
	yarn dev

# Run the app as a NEW user sees it (as fast as dev-fast). FRESH_INSTALL
# clears the webview localStorage on every app start, so the whole
# fresh-install branch runs: onboarding from scratch, turboquant off by default,
# llamacpp-upstream as the default engine. The real dev profile (providers,
# API keys, flags) is backed up and automatically restored on the next regular
# `make dev` / `make dev-fast`; everything done during fresh runs is
# discarded. Models on disk are not deleted (shared data directory), so
# they show up in the list again after onboarding.
dev-fresh: install-and-build
	yarn download:bin
	make download-llamacpp-backend-if-exists
	make download-llamacpp-upstream-backend-if-exists
	make build-mlx-server-if-exists
	make build-foundation-models-server-if-exists
	make build-cli-dev
	FRESH_INSTALL=true FORCE_ONBOARDING=true yarn dev

# Dev mode with a forced SetupScreen (onboarding), without deleting models.
# The FORCE_ONBOARDING flag is passed to vite as a compile-time constant.
dev-onboarding: install-and-build
	yarn download:bin
	make download-llamacpp-backend
	make download-llamacpp-upstream-backend
	make build-mlx-server
	make build-foundation-models-server-if-exists
	make build-cli-dev
	FORCE_ONBOARDING=true yarn dev

# Path to the sibling atomic-chat-conf checkout. Override with:
#   make dev-onboarding-low-spec ATOMIC_CHAT_CONF=~/work/atomic-chat-conf
ATOMIC_CHAT_CONF ?= ../atomic-chat-conf

# Ladder tier to preview onboarding for. Override with:
#   make dev-onboarding-low-spec FORCE_HARDWARE_TIER=unified_8
FORCE_HARDWARE_TIER ?= vram_2

# Onboarding as seen by a user on a low-spec machine: FORCE_HARDWARE_TIER
# bypasses hardware detection, and the first screen shows the recommendation
# for the given ladder tier on any computer.
#
# Value: any id from `HardwareTier` (`web-app/src/lib/hardware-tier.ts`):
# cpu_only, vram_2, vram_4, vram_8, vram_12, vram_16, vram_24, vram_32,
# vram_48, vram_64, vram_64_plus, unified_8, unified_16, unified_24,
# unified_32, unified_48, unified_64, unified_64_plus. The legacy `low` and
# `standard` are also accepted and mapped to the nearest tier.
#
# The manifest is taken from the local conf checkout when present: the remote
# one may not have the `tiers` key yet, but that is fine — without it the client
# falls back to the built-in ladder, which is exactly the recommendation needed.
dev-onboarding-low-spec: install-and-build
	yarn download:bin
	make download-llamacpp-backend
	make download-llamacpp-upstream-backend
	make build-mlx-server
	make build-foundation-models-server-if-exists
	make build-cli-dev
	@if [ -f "$(ATOMIC_CHAT_CONF)/models/recommended.json" ]; then \
		cp "$(ATOMIC_CHAT_CONF)/models/recommended.json" web-app/public/dev-recommended.json; \
		echo "[dev] manifest: $(ATOMIC_CHAT_CONF)/models/recommended.json"; \
		FORCE_ONBOARDING=true FORCE_HARDWARE_TIER=$(FORCE_HARDWARE_TIER) \
			VITE_RECOMMENDED_MODELS_REGISTRY_URL=/dev-recommended.json yarn dev; \
	else \
		echo "[dev] $(ATOMIC_CHAT_CONF) not found — using the manifest from the network (set ATOMIC_CHAT_CONF=...)"; \
		FORCE_ONBOARDING=true FORCE_HARDWARE_TIER=$(FORCE_HARDWARE_TIER) yarn dev; \
	fi

# ──────────────────────────────────────────────────────────────
# Windows Development
# ──────────────────────────────────────────────────────────────

# One-time setup: installs Rust, nvm-windows, Node.js 20, Python, jq, Yarn
setup-windows:
ifeq ($(OS),Windows_NT)
	powershell -ExecutionPolicy Bypass -File scripts/setup-windows.ps1
else
	@echo "This target is for Windows only. Use 'make dev' instead."
endif

# Full dev workflow for Windows (mirrors CI pipeline)
dev-windows:
ifeq ($(OS),Windows_NT)
	powershell -ExecutionPolicy Bypass -File scripts/dev-windows.ps1
else
	@echo "This target is for Windows only. Use 'make dev' instead."
endif

# Same as `dev-windows`, but reuses the llama.cpp backend already downloaded
# under src-tauri/resources/llamacpp-backend-upstream (analogue of `dev-fast`
# for macOS). Skips the GitHub release fetch — fast iteration on the currently
# installed backend without re-downloading.
dev-windows-fast:
ifeq ($(OS),Windows_NT)
	powershell -ExecutionPolicy Bypass -File scripts/dev-windows.ps1 -SkipBackendDownload
else
	@echo "This target is for Windows only. Use 'make dev-fast' instead."
endif

# Dev workflow with CPU-only backend to test runtime GPU auto-download.
# Clears downloaded backends from the Atomic Chat data folder
# (data\llamacpp-upstream\backends), starts with the upstream `win-cpu-x64`
# build, then the llamacpp-upstream extension detects the GPU and downloads
# the optimal backend (CUDA 12.4 / 13.1 / Vulkan) in the background — and
# shows the UI popup.
dev-windows-cpu:
ifeq ($(OS),Windows_NT)
	powershell -ExecutionPolicy Bypass -Command "\
		Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process -Force; \
		Get-Process -Name 'Atomic Chat','atomic-chat' -ErrorAction SilentlyContinue | Stop-Process -Force; \
		Get-Process -Name 'msedgewebview2' -ErrorAction SilentlyContinue | Where-Object { try { $$_.MainModule.FileName -like '*Atomic Chat*' } catch { $$false } } | Stop-Process -Force; \
		Start-Sleep -Seconds 2; \
		$$settingsFile = Join-Path $$env:APPDATA 'chat.atomic.app\settings.json'; \
		$$dataDir = $$null; \
		if (Test-Path $$settingsFile) { \
			$$s = Get-Content $$settingsFile -Raw | ConvertFrom-Json; \
			$$dataDir = $$s.data_folder; \
		}; \
		if (-not $$dataDir) { $$dataDir = Join-Path $$env:APPDATA 'Atomic Chat\data' }; \
		$$backendsDir = Join-Path $$dataDir 'llamacpp-upstream\backends'; \
		if (Test-Path $$backendsDir) { \
			Write-Host ('Clearing downloaded backends from ' + $$backendsDir) -ForegroundColor Yellow; \
			Remove-Item $$backendsDir -Recurse -Force; \
		} else { \
			Write-Host 'No downloaded backends to clear.' -ForegroundColor Gray; \
		}; \
		$$webviewCandidates = @( \
			(Join-Path $$env:LOCALAPPDATA 'chat.atomic.app\EBWebView\Default\Local Storage'), \
			(Join-Path $$env:APPDATA 'chat.atomic.app\EBWebView\Default\Local Storage') \
		); \
		$$wiped = $$false; \
		foreach ($$path in $$webviewCandidates) { \
			if (Test-Path $$path) { \
				Write-Host ('Clearing WebView2 Local Storage from ' + $$path) -ForegroundColor Yellow; \
				Remove-Item $$path -Recurse -Force -ErrorAction SilentlyContinue; \
				if (-not (Test-Path $$path)) { $$wiped = $$true } else { Write-Host ('  WARN: failed to remove ' + $$path + ' (process still locked?)') -ForegroundColor Red } \
			} \
		}; \
		if (-not $$wiped) { Write-Host 'No WebView2 Local Storage was cleared (paths missing or locked).' -ForegroundColor Gray }; \
		$$env:LLAMACPP_BACKEND = 'win-cpu-x64'; \
		Write-Host ''; \
		Write-Host 'Tip: for a full wipe (all data, models, settings, WebView2 cache) run:' -ForegroundColor Cyan; \
		Write-Host '  make clean-windows-all CONFIRM=1' -ForegroundColor Cyan; \
		Write-Host ''; \
		& '$(CURDIR)/scripts/dev-windows.ps1'; \
	"
else
	@echo "This target is for Windows only."
endif

# Full wipe of all Atomic Chat data on Windows — used to simulate a true
# first-launch as if the app had never been installed. Removes the four
# default APPDATA / LOCALAPPDATA directories (see DEVELOP.md → "Where Atomic
# Chat stores data on Windows"). Does NOT touch a custom data_folder if the
# user relocated it via the in-app setting — that is the user's responsibility.
#
# Guarded by CONFIRM=1 so an accidental `make clean-windows-all` only prints
# what would be removed.
clean-windows-all:
ifeq ($(OS),Windows_NT)
ifeq ($(CONFIRM),1)
	powershell -ExecutionPolicy Bypass -Command "\
		Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process -Force; \
		Get-Process -Name 'Atomic Chat','atomic-chat' -ErrorAction SilentlyContinue | Stop-Process -Force; \
		Get-Process -Name 'msedgewebview2' -ErrorAction SilentlyContinue | Where-Object { try { $$_.MainModule.FileName -like '*chat.atomic.app*' -or $$_.MainModule.FileName -like '*Atomic Chat*' } catch { $$false } } | Stop-Process -Force; \
		Start-Sleep -Seconds 2; \
		$$paths = @( \
			(Join-Path $$env:APPDATA 'Atomic Chat'), \
			(Join-Path $$env:APPDATA 'Atomic-Chat'), \
			(Join-Path $$env:APPDATA 'chat.atomic.app'), \
			(Join-Path $$env:LOCALAPPDATA 'chat.atomic.app') \
		); \
		foreach ($$p in $$paths) { \
			if (Test-Path $$p) { \
				Write-Host ('Removing ' + $$p) -ForegroundColor Yellow; \
				Remove-Item $$p -Recurse -Force -ErrorAction SilentlyContinue; \
				if (Test-Path $$p) { Write-Host ('  WARN: failed to fully remove ' + $$p) -ForegroundColor Red } \
			} else { \
				Write-Host ('Not present: ' + $$p) -ForegroundColor Gray; \
			} \
		}; \
		Write-Host 'Atomic Chat: full data wipe done.' -ForegroundColor Green; \
	"
else
	@powershell -NoProfile -ExecutionPolicy Bypass -Command "\
		Write-Host 'DRY RUN. Nothing was deleted.' -ForegroundColor Yellow; \
		Write-Host 'These paths WOULD be removed when re-run with CONFIRM=1:' -ForegroundColor Yellow; \
		$$paths = @( \
			(Join-Path $$env:APPDATA 'Atomic Chat'), \
			(Join-Path $$env:APPDATA 'Atomic-Chat'), \
			(Join-Path $$env:APPDATA 'chat.atomic.app'), \
			(Join-Path $$env:LOCALAPPDATA 'chat.atomic.app') \
		); \
		foreach ($$p in $$paths) { \
			$$exists = if (Test-Path $$p) { '[exists]' } else { '[not present]' }; \
			Write-Host ('  ' + $$p + '  ' + $$exists) -ForegroundColor Gray; \
		}; \
		Write-Host ''; \
		Write-Host 'Run again with CONFIRM=1 to actually delete:' -ForegroundColor Yellow; \
		Write-Host '  make clean-windows-all CONFIRM=1' -ForegroundColor Cyan; \
	"
endif
else
	@echo "This target is for Windows only."
endif

# Web application targets
install-web-app:
	yarn install

dev-web-app: install-web-app
	yarn build:core
	yarn dev:web-app

build-web-app: install-web-app
	yarn build:core
	yarn build:web-app

serve-web-app:
	yarn serve:web-app

build-serve-web-app: build-web-app
	yarn serve:web-app

# Mobile
dev-android: install-and-build install-android-rust-targets
	@echo "Setting up Android development environment..."
	@if [ ! -d "src-tauri/gen/android" ]; then \
		echo "Android app not initialized. Initializing..."; \
		yarn tauri android init; \
	fi
	@echo "Sourcing Android environment setup..."
	@bash autoqa/scripts/setup-android-env.sh echo "Android environment ready"
	@echo "Starting Android development server..."
	yarn dev:android

dev-ios: install-and-build install-ios-rust-targets
	@echo "Setting up iOS development environment..."
ifeq ($(shell uname -s),Darwin)
	@if [ ! -d "src-tauri/gen/ios" ]; then \
		echo "iOS app not initialized. Initializing..."; \
		yarn tauri ios init; \
	fi
	@echo "Checking iOS development requirements..."
	@xcrun --version > /dev/null 2>&1 || (echo "❌ Xcode command line tools not found. Install with: xcode-select --install" && exit 1)
	@xcrun simctl list devices available | grep -q "iPhone\|iPad" || (echo "❌ No iOS simulators found. Install simulators through Xcode." && exit 1)
	@echo "Starting iOS development server..."
	yarn dev:ios
else
	@echo "❌ iOS development is only supported on macOS"
	@exit 1
endif

# Linting
lint: install-and-build
	yarn lint

# Testing
.PHONY: test test-all test-local test-web test-extensions test-rust stub-resources \
	typecheck verify-fast verify test-quality test-hardening-contracts \
	test-telemetry-props test-coverage-critical capture-capabilities capture-hw-profile \
	sync-upstream-baseline gen-amd-rocm-pci-ids test-live test-live-cloud mutants \
	build-app-e2e test-app-e2e test-app-e2e-live

test-web:
	yarn test

test-extensions:
	yarn --cwd extensions workspaces foreach -A \
		--include '@janhq/llamacpp-extension' \
		--include '@janhq/llamacpp-upstream-extension' \
		--include '@janhq/mlx-extension' \
		--include '@janhq/download-extension' \
		run test:run

# Tauri validates bundle.resources and externalBin paths while compiling the
# test target. Tests never execute these artefacts, so create only missing
# placeholders and never overwrite a real local build.
stub-resources:
ifeq ($(OS),Windows_NT)
	powershell -NoProfile -Command "\
		$$files = @( \
			'src-tauri/resources/LICENSE', \
			'src-tauri/resources/pre-install/test-placeholder', \
			'src-tauri/resources/bin/jan-cli.exe', \
			'src-tauri/resources/bin/atomic-chat-core.exe', \
			'src-tauri/resources/bin/atomic-chat-app-core.exe', \
			'src-tauri/resources/bin/bun-x86_64-pc-windows-msvc.exe', \
			'src-tauri/resources/bin/uv-x86_64-pc-windows-msvc.exe', \
			'src-tauri/resources/bin/cloudflared-x86_64-pc-windows-msvc.exe', \
			'src-tauri/resources/llamacpp-backend/test-placeholder', \
			'src-tauri/resources/llamacpp-backend-upstream/test-placeholder' \
		); \
		foreach ($$file in $$files) { \
			$$parent = Split-Path -Parent $$file; \
			New-Item -ItemType Directory -Force -Path $$parent | Out-Null; \
			if (-not (Test-Path $$file)) { New-Item -ItemType File -Path $$file | Out-Null } \
		}"
else ifeq ($(shell uname -s),Darwin)
	@mkdir -p src-tauri/resources/bin src-tauri/resources/pre-install src-tauri/resources/llamacpp-backend src-tauri/resources/llamacpp-backend-upstream
	@[ -e src-tauri/resources/LICENSE ] || touch src-tauri/resources/LICENSE
	@[ -e src-tauri/resources/pre-install/test-placeholder ] || touch src-tauri/resources/pre-install/test-placeholder
	@[ -e src-tauri/resources/bin/jan-cli ] || touch src-tauri/resources/bin/jan-cli
	@[ -e src-tauri/resources/bin/atomic-chat-core ] || touch src-tauri/resources/bin/atomic-chat-core
	@[ -e src-tauri/resources/bin/atomic-chat-app-core ] || touch src-tauri/resources/bin/atomic-chat-app-core
	@[ -e src-tauri/resources/bin/mlx-server ] || touch src-tauri/resources/bin/mlx-server
	@[ -e src-tauri/resources/bin/mlx-server-version.txt ] || touch src-tauri/resources/bin/mlx-server-version.txt
	@[ -e src-tauri/resources/bin/mlx-server-backend.txt ] || touch src-tauri/resources/bin/mlx-server-backend.txt
	@[ -e src-tauri/resources/bin/foundation-models-server ] || touch src-tauri/resources/bin/foundation-models-server
	@[ -e src-tauri/resources/bin/bun-aarch64-apple-darwin ] || touch src-tauri/resources/bin/bun-aarch64-apple-darwin
	@[ -e src-tauri/resources/bin/bun-x86_64-apple-darwin ] || touch src-tauri/resources/bin/bun-x86_64-apple-darwin
	@[ -e src-tauri/resources/bin/uv-aarch64-apple-darwin ] || touch src-tauri/resources/bin/uv-aarch64-apple-darwin
	@[ -e src-tauri/resources/bin/uv-x86_64-apple-darwin ] || touch src-tauri/resources/bin/uv-x86_64-apple-darwin
	@[ -e src-tauri/resources/bin/cloudflared-aarch64-apple-darwin ] || touch src-tauri/resources/bin/cloudflared-aarch64-apple-darwin
	@[ -e src-tauri/resources/bin/cloudflared-x86_64-apple-darwin ] || touch src-tauri/resources/bin/cloudflared-x86_64-apple-darwin
else
	@mkdir -p src-tauri/resources/bin src-tauri/resources/pre-install src-tauri/resources/llamacpp-backend src-tauri/resources/llamacpp-backend-upstream
	@[ -e src-tauri/resources/LICENSE ] || touch src-tauri/resources/LICENSE
	@[ -e src-tauri/resources/pre-install/test-placeholder ] || touch src-tauri/resources/pre-install/test-placeholder
	@[ -e src-tauri/resources/bin/jan-cli ] || touch src-tauri/resources/bin/jan-cli
	@[ -e src-tauri/resources/bin/atomic-chat-app-core ] || touch src-tauri/resources/bin/atomic-chat-app-core
	@[ -e src-tauri/resources/bin/sqlite-vec.so ] || touch src-tauri/resources/bin/sqlite-vec.so
	@[ -e src-tauri/resources/bin/uv-x86_64-unknown-linux-gnu ] || touch src-tauri/resources/bin/uv-x86_64-unknown-linux-gnu
	@[ -e src-tauri/resources/bin/cloudflared-x86_64-unknown-linux-gnu ] || touch src-tauri/resources/bin/cloudflared-x86_64-unknown-linux-gnu
	@[ -e src-tauri/resources/llamacpp-backend/test-placeholder ] || touch src-tauri/resources/llamacpp-backend/test-placeholder
	@[ -e src-tauri/resources/llamacpp-backend-upstream/test-placeholder ] || touch src-tauri/resources/llamacpp-backend-upstream/test-placeholder
endif

test-rust: export TAURI_CONFIG := {"bundle":{"icon":["icons/icon.png"]}}
test-rust: stub-resources
	cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --features test-tauri -- --test-threads=1
	cargo test --manifest-path src-tauri/plugins/tauri-plugin-atomic-audio/Cargo.toml
	cargo test --manifest-path src-tauri/plugins/tauri-plugin-hardware/Cargo.toml
	cargo test --manifest-path src-tauri/plugins/tauri-plugin-llamacpp/Cargo.toml
	cargo test --manifest-path src-tauri/plugins/tauri-plugin-llamacpp-upstream/Cargo.toml -- --test-threads=1
ifeq ($(shell uname -s),Darwin)
	cargo test --manifest-path src-tauri/plugins/tauri-plugin-mlx/Cargo.toml
endif
	cargo test --manifest-path src-tauri/utils/Cargo.toml

# Fast local suite: root Vitest, extension Vitest, and every test-bearing
# Rust crate supported on the current platform.
test-local: test-web test-extensions test-rust

# Reject false-confidence test patterns before running the suites.
test-quality:
	node scripts/check-test-quality.mjs

test-hardening-contracts:
	node --test tests/capabilities.test.mjs \
		tests/extension-surface.test.mjs \
		tests/pre-install-tarballs.test.mjs \
		tests/registry-contracts.test.mjs \
		tests/hardware-profiles.test.mjs \
		tests/upstream-backend-resolver.test.mjs \
		tests/core-contracts.test.mjs \
		tests/core-settings-schema.test.mjs \
		tests/desktop-legacy-path.test.mjs \
		tests/extension-bundles.test.mjs \
		tests/cli-launch-catalog.test.mjs

test-coverage-critical:
	yarn test:coverage
	yarn --cwd extensions workspaces foreach -A \
		--include '@janhq/llamacpp-extension' \
		--include '@janhq/llamacpp-upstream-extension' \
		run test:coverage
	node scripts/check-coverage-floor.mjs

# The same `tsc -b` the release build runs inside `yarn build:web`. ESLint and
# Vitest never check types (vite strips them unchecked), so without this the
# first tsc a change ever meets is the tag-triggered release build.
typecheck:
	yarn workspace @janhq/web-app run tsc -b

# Reserved PostHog property names. Cheap and independent of any build output,
# so it runs before the suites that take minutes.
test-telemetry-props:
	node scripts/check-telemetry-props.mjs

verify-fast:
	yarn lint
	"$(MAKE)" typecheck
	"$(MAKE)" test-telemetry-props
	"$(MAKE)" test-quality
	"$(MAKE)" test-hardening-contracts
	"$(MAKE)" test-coverage-critical

verify: verify-fast test-rust

# Explicitly live capture commands. The caller supplies paths/identity so these
# never download artifacts or mutate fixtures during a normal verification run.
capture-capabilities:
	@test -n "$(PROVIDER)" || (echo "PROVIDER is required" && exit 2)
	@test -n "$(BINARY)" || (echo "BINARY is required" && exit 2)
	@test -n "$(OUTPUT)" || (echo "OUTPUT is required" && exit 2)
	node scripts/capture-capabilities.mjs "$(PROVIDER)" "$(BINARY)" "$(OUTPUT)" "$(VERSION)"

capture-hw-profile:
	@test -n "$(OUTPUT)" || (echo "OUTPUT is required" && exit 2)
	node scripts/capture-hw-profile.mjs "$(OUTPUT)"

# Regenerate the offline backend baseline (and its fixture) from the live
# atomic-chat-conf manifest. Live network, so it is not part of verify.
sync-upstream-baseline:
	node scripts/sync-upstream-baseline.mjs $(if $(REVISION),--revision $(REVISION),)

# Regenerate the AMD PCI device id -> gfx table that gates the Windows ROCm
# backend, from AMD's HIP SDK support matrix and pci.ids. Live network.
gen-amd-rocm-pci-ids:
	node scripts/gen-amd-rocm-pci-ids.mjs

# Opt-in acceptance against live local binaries and moving external registries.
# Missing sidecar env vars are reported as skips; use REQUIRE=1 to make them
# mandatory. These targets are intentionally excluded from verify/verify-fast.
test-live:
	python3 scripts/test-local-sidecars.py $(if $(filter 1,$(REQUIRE)),--require,)
	ATOMIC_TEST_LIVE_REGISTRIES=1 yarn workspace @janhq/web-app vitest --run \
		src/services/__tests__/external-contracts.test.ts

test-live-cloud:
	python3 scripts/record-cloud-live.py $(if $(filter 1,$(REQUIRE)),--require,)

# The core supervisor against a real `atomic-chat-core` binary, which is the
# only way to check that the app and the core agree about the lock file, the
# control token and what a dead owner looks like. The fake core in the unit
# tests proves the app's half only. Point ATOMIC_CORE_BIN at a built core
# (`npm run build:bin` in atomic-chat-core writes one to dist/bin/), or at the
# one this app bundles after `make download-core`.
ATOMIC_CORE_BIN ?= $(CURDIR)/src-tauri/resources/bin/atomic-chat-app-core
test-core-live:
	ATOMIC_CORE_BIN="$(ATOMIC_CORE_BIN)" cargo test --manifest-path src-tauri/Cargo.toml \
		-p Atomic-Chat --features test-tauri --lib core::atomic_core::live_tests -- --test-threads=1

# Desktop UI end-to-end tests: the real app binary, the real core and a fake
# llama-server, driven through a WebDriver server that exists only in a build
# with `--features e2e`. See tests/e2e/ and the ADR on desktop e2e.
#
# The build gets its own target directory. At startup the app reaps orphaned
# backends under its resource dir, which for an unbundled binary is the cargo
# output dir — sharing `target/debug` would let a test run kill the backends of
# a `yarn dev` session. The path must keep `target` as its third-last component
# or Tauri stops treating the binary's directory as the resource dir.
#
# No analytics or crash-reporting key reaches the binary, the registries point
# at a closed port so the bundled seeds are used, and the web build calls the
# local tsc/vite directly so the target does not depend on which yarn is on PATH.
E2E_TARGET_DIR := $(CURDIR)/src-tauri/target/e2e
E2E_APP_BIN := $(E2E_TARGET_DIR)/debug/Atomic-Chat
E2E_DEAD_URL := http://127.0.0.1:9
build-app-e2e:
	@test -z "$$(ls src-tauri/.env web-app/.env* 2>/dev/null)" || \
		(echo "build-app-e2e: remove src-tauri/.env and web-app/.env* first; their keys would be baked into the test build" && exit 1)
	@oldest=$$(ls -tr src-tauri/resources/pre-install/*.tgz | head -1); \
	stale=$$(find extensions/*/src extensions/shared -type f -newer "$$oldest" 2>/dev/null | head -5); \
	if [ -n "$$stale" ] && [ "$(ALLOW_STALE_EXTENSIONS)" != "1" ]; then \
		echo "build-app-e2e: extension sources are newer than the packed extensions the app installs:"; \
		echo "$$stale"; \
		echo "The app unpacks src-tauri/resources/pre-install/*.tgz without a version check, so the tests would"; \
		echo "run old extension code. Run \`yarn build:extensions && yarn copy:assets:tauri\`, or pass"; \
		echo "ALLOW_STALE_EXTENSIONS=1 for a scenario that does not depend on them."; \
		exit 1; \
	fi
	@for packed in src-tauri/resources/pre-install/*.tgz; do \
		if tar -xzOf "$$packed" package/dist/index.js 2>/dev/null | grep -q '@janhq/tauri-plugin-[a-z-]*-api'; then \
			echo "build-app-e2e: $$packed imports a Tauri plugin API it did not bundle, so the webview cannot load it."; \
			echo "The plugin JS was not built when the extensions were: run \`yarn build:tauri:plugin:api\` first,"; \
			echo "then \`yarn build:extensions && yarn copy:assets:tauri\`."; \
			exit 1; \
		fi; \
	done
	env -u CI CARGO_TARGET_DIR="$(E2E_TARGET_DIR)" \
		POSTHOG_KEY= POSTHOG_HOST= GA_MEASUREMENT_ID= SENTRY_DSN= SENTRY_DSN_DESKTOP= \
		SENTRY_AUTH_TOKEN= SENTRY_ORG= SENTRY_PROJECT_FRONTEND= AUTO_UPDATER_DISABLED=true \
		VITE_MODEL_CATALOG_URL=$(E2E_DEAD_URL)/catalog.json \
		VITE_MODEL_CATALOG_INDEX_URL=$(E2E_DEAD_URL)/index.json \
		VITE_PROVIDER_REGISTRY_URL=$(E2E_DEAD_URL)/providers.json \
		VITE_RECOMMENDED_MODELS_REGISTRY_URL=$(E2E_DEAD_URL)/recommended.json \
		VITE_STAFF_PICKS_REGISTRY_URL=$(E2E_DEAD_URL)/staff-picks.json \
		./node_modules/.bin/tauri build --debug --no-bundle --features e2e \
		--config src-tauri/tauri.e2e.conf.json

# Refuses a binary older than what it was built from: a stale one may predate an
# isolation fix and write into the developer's own profile.
test-app-e2e:
	@test -x "$(E2E_APP_BIN)" || (echo "test-app-e2e: no e2e build; run \`make build-app-e2e\`" && exit 2)
	@test -x "$(ATOMIC_CORE_BIN)" || (echo "test-app-e2e: no core at ATOMIC_CORE_BIN=$(ATOMIC_CORE_BIN)" && exit 2)
	@stale=$$(find src-tauri/src src-tauri/Cargo.toml src-tauri/tauri.conf.json src-tauri/tauri.macos.conf.json \
		src-tauri/tauri.e2e.conf.json web-app/src -newer "$(E2E_APP_BIN)" -type f 2>/dev/null | head -5); \
	if [ -n "$$stale" ]; then \
		echo "test-app-e2e: the e2e build is older than its sources; run \`make build-app-e2e\`:"; echo "$$stale"; exit 2; \
	fi
	@test -d tests/e2e/node_modules || (cd tests/e2e && npm install --no-audit --no-fund)
	cd tests/e2e && ATOMIC_E2E_APP_BIN="$(E2E_APP_BIN)" ATOMIC_CORE_BIN="$(ATOMIC_CORE_BIN)" \
		./node_modules/.bin/vitest run

# The one scenario that uses a real llama-server and a real model instead of
# the scripted backend. Opt-in: point the two variables at a backend directory
# (the one holding `build/`) and a GGUF file. Both are only read — the backend
# is copied into the test profile, the model is referenced where it lies.
ATOMIC_E2E_LLAMA_BACKEND_DIR ?=
ATOMIC_E2E_MODEL_GGUF ?=
test-app-e2e-live:
	@test -x "$(E2E_APP_BIN)" || (echo "test-app-e2e-live: no e2e build; run \`make build-app-e2e\`" && exit 2)
	@test -x "$(ATOMIC_CORE_BIN)" || (echo "test-app-e2e-live: no core at ATOMIC_CORE_BIN=$(ATOMIC_CORE_BIN)" && exit 2)
	@test -d "$(ATOMIC_E2E_LLAMA_BACKEND_DIR)/build" || (echo "test-app-e2e-live: ATOMIC_E2E_LLAMA_BACKEND_DIR must hold a llama.cpp backend's build/ directory" && exit 2)
	@test -f "$(ATOMIC_E2E_MODEL_GGUF)" || (echo "test-app-e2e-live: ATOMIC_E2E_MODEL_GGUF must be a GGUF file" && exit 2)
	cd tests/e2e && ATOMIC_E2E_APP_BIN="$(E2E_APP_BIN)" ATOMIC_CORE_BIN="$(ATOMIC_CORE_BIN)" \
		ATOMIC_E2E_LLAMA_BACKEND_DIR="$(ATOMIC_E2E_LLAMA_BACKEND_DIR)" ATOMIC_E2E_MODEL_GGUF="$(ATOMIC_E2E_MODEL_GGUF)" \
		./node_modules/.bin/vitest run desktop/live-model.spec.ts

mutants:
	bash scripts/test-cargo-mutants.sh

test-agent:
	cargo test --manifest-path src-tauri/Cargo.toml -p Atomic-Chat core::agent

ATOMIC_AGENT_E2E_LLAMA_SERVER ?= $(CURDIR)/src-tauri/resources/llamacpp-backend/build/bin/llama-server
ATOMIC_AGENT_E2E_MODEL ?= $(HOME)/Library/Application Support/Atomic Chat/data/llamacpp/models/unsloth/Qwen3_5-9B-GGUF-Qwen3_5-9B-IQ4_XS/model.gguf
ifeq ($(OS),Windows_NT)
GAIA_LLAMA_SERVER ?= $(CURDIR)/src-tauri/resources/llamacpp-backend-upstream/build/bin/llama-server.exe
else
GAIA_LLAMA_SERVER ?= $(ATOMIC_AGENT_E2E_LLAMA_SERVER)
endif
GAIA_MODEL ?= $(ATOMIC_AGENT_E2E_MODEL)

test-agent-model:
	@test -x "$(ATOMIC_AGENT_E2E_LLAMA_SERVER)" || (echo "llama-server not found: $(ATOMIC_AGENT_E2E_LLAMA_SERVER)" && exit 1)
	@test -f "$(ATOMIC_AGENT_E2E_MODEL)" || (echo "model not found: $(ATOMIC_AGENT_E2E_MODEL)" && exit 1)
	ATOMIC_AGENT_E2E_LLAMA_SERVER="$(ATOMIC_AGENT_E2E_LLAMA_SERVER)" \
	ATOMIC_AGENT_E2E_MODEL="$(ATOMIC_AGENT_E2E_MODEL)" \
	cargo test --manifest-path src-tauri/Cargo.toml -p Atomic-Chat \
		managed_model_agent_scenarios -- --ignored --nocapture --test-threads=1

GAIA_SKILLS_DIR ?= $(CURDIR)/src-tauri/resources/agent-skills

.PHONY: gaia-eval
gaia-eval:
	@test -x "$(GAIA_LLAMA_SERVER)" || (echo "llama-server not found or not executable: $(GAIA_LLAMA_SERVER)" && exit 1)
	@test -f "$(GAIA_MODEL)" || (echo "model not found: $(GAIA_MODEL)" && exit 1)
	GAIA_LLAMA_SERVER="$(GAIA_LLAMA_SERVER)" \
	GAIA_MODEL="$(GAIA_MODEL)" \
	GAIA_SKILLS_DIR="$(GAIA_SKILLS_DIR)" \
	cargo run --manifest-path src-tauri/Cargo.toml -p Atomic-Chat \
		--features gaia-eval --example gaia-eval

test: lint install-rust-targets
	yarn download:bin
ifeq ($(OS),Windows_NT)
endif
	yarn copy:assets:tauri
	yarn build:icon
	yarn build:mlx-server
	make build-foundation-models-server-if-exists
	make build-cli
	$(MAKE) test-local

# Exhaustive developer verification: prepare every bundled artefact, run the
# deterministic quality/coverage/Rust gate, then exercise live contracts.
# Unconfigured sidecars and cloud providers are reported as skips. REQUIRE=1
# makes those live prerequisites mandatory.
test-all: install-and-build install-rust-targets
	yarn download:bin
	yarn copy:assets:tauri
	yarn build:icon
	yarn build:mlx-server
	$(MAKE) build-foundation-models-server-if-exists
	$(MAKE) build-cli
	python3 scripts/run_test_all.py \
		--make "$(MAKE)" \
		$(if $(filter 1,$(REQUIRE)),--require-live,)

# Download MLX server binary (mlx-vlm fork) from GitHub releases (macOS only)
# Supports GH_TOKEN env var for authenticated GitHub API requests (avoids rate limits in CI)
# Pinned compatibility baseline. Override only for a dedicated compatibility
# validation run; normal builds never resolve a moving latest release.
# Example:
#   make build-mlx-server MLXVLM_TAG=mlxvlm-macos-arm64-abc1234
MLXVLM_TAG ?= mlxvlm-macos-arm64-07ba5a1
build-mlx-server:
ifeq ($(shell uname -s),Darwin)
	@mkdir -p src-tauri/resources/bin
	@echo "Downloading MLX server binary (mlx-vlm)..."; \
	if [ -n "$(MLXVLM_TAG)" ]; then \
		TAG="$(MLXVLM_TAG)"; \
		echo "Using pinned release: $$TAG"; \
	else \
		echo "Fetching latest mlx-vlm release..."; \
		API_URL="https://api.github.com/repos/AtomicBot-ai/mlx-vlm/releases?per_page=50"; \
		TMPREL=$$(mktemp /tmp/mlxvlm-releases-XXXXXX.json); \
		_gh_get() { \
			if [ "$$1" = "1" ] && [ -n "$$GH_TOKEN" ]; then \
				curl -sS -H "Authorization: Bearer $$GH_TOKEN" -H "Accept: application/vnd.github+json" -H "User-Agent: atomic-chat-ci" -o "$$2" -w "%{http_code}" "$$3" || echo "000"; \
			else \
				curl -sS -H "Accept: application/vnd.github+json" -H "User-Agent: atomic-chat-ci" -o "$$2" -w "%{http_code}" "$$3" || echo "000"; \
			fi; \
		}; \
		_gh_fetch() { \
			HTTP_CODE=""; \
			for attempt in 1 2 3 4 5; do \
				HTTP_CODE=$$(_gh_get "$$1" "$$2" "$$3"); \
				case "$$HTTP_CODE" in \
					2*) return 0 ;; \
					403|429|5*|000) \
						echo "  GitHub API attempt $$attempt/5 (auth=$$1): HTTP $$HTTP_CODE, retrying in $$((attempt * 2))s..."; \
						sleep $$((attempt * 2)) ;; \
					*) return 1 ;; \
				esac; \
			done; \
			return 1; \
		}; \
		_response_ok() { \
			[ -s "$$1" ] && jq -e 'type == "array" and length > 0' "$$1" >/dev/null 2>&1; \
		}; \
		USE_TOKEN=0; [ -n "$$GH_TOKEN" ] && USE_TOKEN=1; \
		_gh_fetch "$$USE_TOKEN" "$$TMPREL" "$$API_URL" || true; \
		FIRST_CODE="$$HTTP_CODE"; \
		if ! _response_ok "$$TMPREL" && [ "$$USE_TOKEN" = "1" ]; then \
			echo "Token-authenticated request did not yield usable releases (HTTP $$FIRST_CODE); retrying unauthenticated..."; \
			_gh_fetch "0" "$$TMPREL" "$$API_URL" || true; \
		fi; \
		case "$$HTTP_CODE" in \
			2*) ;; \
			*) echo "Error: GitHub API failed (last HTTP $$HTTP_CODE)"; \
			   echo "  body (first 500 bytes):"; head -c 500 "$$TMPREL" 2>/dev/null || true; echo; \
			   rm -f "$$TMPREL"; exit 1 ;; \
		esac; \
		if [ ! -s "$$TMPREL" ] || ! jq -e 'type == "array"' "$$TMPREL" >/dev/null 2>&1; then \
			echo "Error: GitHub API returned non-array or empty response (HTTP $$HTTP_CODE):"; \
			head -c 500 "$$TMPREL" 2>/dev/null || true; echo; \
			rm -f "$$TMPREL"; exit 1; \
		fi; \
		REL_COUNT=$$(jq 'length' "$$TMPREL"); \
		echo "GitHub API returned $$REL_COUNT release(s)"; \
		TAG=$$(jq -r '[.[] | select(.tag_name | startswith("mlxvlm-macos-arm64"))] | sort_by(.published_at // .created_at) | reverse | .[0].tag_name // empty' "$$TMPREL"); \
		if [ -z "$$TAG" ]; then \
			echo "Error: No mlx-vlm release found matching 'mlxvlm-macos-arm64*'. First 10 tags in response:"; \
			jq -r '.[0:10] | .[].tag_name' "$$TMPREL" || true; \
			rm -f "$$TMPREL"; exit 1; \
		fi; \
		rm -f "$$TMPREL"; \
	fi; \
	echo "Release: $$TAG"; \
	URL="https://github.com/AtomicBot-ai/mlx-vlm/releases/download/$$TAG/mlxvlm-mlx-server-macos-arm64.tar.gz"; \
	echo "Downloading: $$URL"; \
	curl -fSL "$$URL" -o /tmp/mlxvlm-mlx-server.tar.gz; \
	tar -xzf /tmp/mlxvlm-mlx-server.tar.gz -C src-tauri/resources/bin/; \
	rm -f /tmp/mlxvlm-mlx-server.tar.gz; \
	chmod +x src-tauri/resources/bin/mlx-server; \
	echo "$$TAG" > src-tauri/resources/bin/mlx-server-version.txt; \
	echo "macos-arm64" > src-tauri/resources/bin/mlx-server-backend.txt; \
	echo "MLX server (mlx-vlm) downloaded and extracted successfully ($$TAG)"
	@SIGNING_IDENTITY=$$(security find-identity -v -p codesigning | grep "Developer ID Application" | head -1 | sed 's/.*"\(.*\)".*/\1/'); \
	if [ -n "$$SIGNING_IDENTITY" ]; then \
		echo "Signing mlx-server with identity: $$SIGNING_IDENTITY"; \
		codesign --force --options runtime --timestamp --entitlements src-tauri/Entitlements.plist --sign "$$SIGNING_IDENTITY" src-tauri/resources/bin/mlx-server; \
		echo "Code signing completed successfully"; \
	else \
		echo "Warning: No Developer ID Application identity found. Applying ad-hoc signature."; \
		codesign --force --deep --sign - src-tauri/resources/bin/mlx-server; \
	fi
	@mkdir -p src-tauri/target/debug/resources/bin; \
	cp src-tauri/resources/bin/mlx-server src-tauri/target/debug/resources/bin/mlx-server; \
	cp src-tauri/resources/bin/mlx-server-version.txt src-tauri/target/debug/resources/bin/mlx-server-version.txt; \
	cp src-tauri/resources/bin/mlx-server-backend.txt src-tauri/target/debug/resources/bin/mlx-server-backend.txt; \
	echo "Debug copy updated with signed binary"
else
	@echo "Skipping MLX server download (macOS only)"
endif

# Download MLX server if missing or different from the verified pin.
build-mlx-server-if-exists:
ifeq ($(shell uname -s),Darwin)
	@if [ ! -f "src-tauri/resources/bin/mlx-server" ] || [ ! -f "src-tauri/resources/bin/mlx-server-version.txt" ]; then \
		echo "MLX server binary or version file missing — downloading..."; \
		make build-mlx-server; \
	else \
		LOCAL_TAG=$$(cat src-tauri/resources/bin/mlx-server-version.txt 2>/dev/null); \
		if [ "$$LOCAL_TAG" = "$(MLXVLM_TAG)" ]; then \
			echo "MLX server is up-to-date ($$LOCAL_TAG)"; \
		else \
			echo "MLX server differs from verified pin: local=$$LOCAL_TAG pinned=$(MLXVLM_TAG) — updating..."; \
			make build-mlx-server; \
		fi; \
	fi
else
	@echo "Skipping MLX server build (macOS only)"
endif

# Build Apple Foundation Models server (macOS 26+ only) - always builds
build-foundation-models-server:
ifeq ($(shell uname -s),Darwin)
	@echo "Building Foundation Models server for macOS 26+..."
	cd foundation-models-server && swift build -c release
	@echo "Copying foundation-models-server binary..."
	@cp foundation-models-server/.build/release/foundation-models-server src-tauri/resources/bin/foundation-models-server
	@chmod +x src-tauri/resources/bin/foundation-models-server
	@echo "Foundation Models server built and copied successfully"
	@echo "Checking for code signing identity..."
	@SIGNING_IDENTITY=$$(security find-identity -v -p codesigning | grep "Developer ID Application" | head -1 | sed 's/.*"\(.*\)".*/\1/'); \
	if [ -n "$$SIGNING_IDENTITY" ]; then \
		echo "Signing foundation-models-server with identity: $$SIGNING_IDENTITY"; \
		codesign --force --options runtime --timestamp --sign "$$SIGNING_IDENTITY" src-tauri/resources/bin/foundation-models-server; \
		echo "Code signing completed successfully"; \
	else \
		echo "Warning: No Developer ID Application identity found. Skipping code signing."; \
	fi
else
	@echo "Skipping Foundation Models server build (macOS only)"
endif

# Build Foundation Models server only if not already present (for dev)
build-foundation-models-server-if-exists:
ifeq ($(shell uname -s),Darwin)
	@if [ -f "src-tauri/resources/bin/foundation-models-server" ]; then \
		echo "Foundation Models server already exists at src-tauri/resources/bin/foundation-models-server, skipping build..."; \
	else \
		make build-foundation-models-server; \
	fi
else
	@echo "Skipping Foundation Models server build (macOS only)"
endif

# Download llamacpp turboquant backend for bundling.
# No release tag is pinned here: scripts/resolve-turboquant-release.sh asks the
# fork's own releases/latest which stable release is current, so a new fork
# release lands in the next build without a commit in this repo. The archive
# itself comes from the AtomicBot-ai releases CDN.
# TURBOQUANT_TAG pins one explicitly for a reproducible CI build; LLAMACPP_TAG
# is its older spelling and still honoured.
# Example:
#   make download-llamacpp-backend TURBOQUANT_TAG=b10018-1.3.0
TURBOQUANT_RESOLVE = ./scripts/resolve-turboquant-release.sh
TURBOQUANT_DETECT = ./scripts/detect-turboquant-backend.sh
LLAMACPP_TAG ?=
TURBOQUANT_TAG ?= $(LLAMACPP_TAG)
# Linux only: which variant to fetch. Empty means the bundled Vulkan fallback;
# `update-llamacpp-backend` fills it with the tier this host would run.
TURBOQUANT_BACKEND ?=
download-llamacpp-backend:
ifeq ($(shell uname -s),Darwin)
	@mkdir -p src-tauri/resources/llamacpp-backend
	@ARCH=$$(uname -m); \
	if [ "$$ARCH" != "arm64" ]; then \
		echo "Skipping TurboQuant backend: no verified macOS x64 release exists"; \
		exit 0; \
	fi; \
	BACKEND="macos-arm64"; \
	echo "Platform: $$BACKEND"; \
	RESOLVED=$$($(TURBOQUANT_RESOLVE) "$$BACKEND" "$(TURBOQUANT_TAG)") || exit 1; \
	TAG=$${RESOLVED%% *}; \
	ASSET=$${RESOLVED#* }; \
	URL="https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/download/$$TAG/$$ASSET"; \
	echo "$$TAG" > src-tauri/resources/llamacpp-backend/version.txt; \
	echo "$$BACKEND" > src-tauri/resources/llamacpp-backend/backend.txt; \
	echo "Release: $$TAG  Backend: $$BACKEND"; \
	echo "Downloading: $$URL"; \
	curl -fSL --retry 5 --retry-delay 3 "$$URL" -o /tmp/llamacpp-backend.tar.gz; \
	tar -xzf /tmp/llamacpp-backend.tar.gz -C src-tauri/resources/llamacpp-backend/; \
	rm -f /tmp/llamacpp-backend.tar.gz; \
	echo "Downloaded and extracted llamacpp backend successfully"
	@SIGNING_IDENTITY=$$(security find-identity -v -p codesigning | grep "Developer ID Application" | head -1 | sed 's/.*"\(.*\)".*/\1/'); \
	if [ -n "$$SIGNING_IDENTITY" ]; then \
		echo "Signing llamacpp backend binaries..."; \
		for bin in src-tauri/resources/llamacpp-backend/build/bin/*; do \
			if [ -f "$$bin" ] && file "$$bin" | grep -q "Mach-O"; then \
				codesign --force --options runtime --timestamp --entitlements src-tauri/Entitlements.plist --sign "$$SIGNING_IDENTITY" "$$bin"; \
			fi; \
		done; \
		echo "Code signing completed"; \
	else \
		echo "Warning: No Developer ID Application identity found. Skipping code signing."; \
	fi
else ifeq ($(OS),Windows_NT)
	@$(MAKE) download-llamacpp-backend-win-cpu
else ifeq ($(shell uname -s),Linux)
	@mkdir -p src-tauri/resources/llamacpp-backend
	@# TurboQuant ships on Linux as the second provider alongside
	@# llamacpp-upstream. The fork also publishes Linux CPU/CUDA/ROCm builds,
	@# but linux-x64-vulkan is the one a release bundles: it serves both CPU and
	@# GPU via GGML_BACKEND_DL, so it is the offline fallback that works on any
	@# host. The GPU tiers are runtime downloads; TURBOQUANT_BACKEND overrides the
	@# variant for a dev box only. The backend index is resolved
	@# from the static turboquant manifest in atomic-chat-conf
	@# (raw.githubusercontent.com — no api.github.com rate limit); the archive
	@# download itself comes from the AtomicBot-ai releases CDN.
	@BACKEND="$(TURBOQUANT_BACKEND)"; \
	if [ -z "$$BACKEND" ]; then BACKEND="linux-x64-vulkan"; fi; \
	if [ "$$BACKEND" != "linux-x64-vulkan" ]; then \
		echo "Warning: bundling $$BACKEND, not the portable linux-x64-vulkan fallback."; \
		echo "         Run 'make download-llamacpp-backend' before packaging a release."; \
	fi; \
	echo "Platform: $$BACKEND (turboquant / Linux)"; \
	RESOLVED=$$($(TURBOQUANT_RESOLVE) "$$BACKEND" "$(TURBOQUANT_TAG)") || exit 1; \
	TAG=$${RESOLVED%% *}; \
	ASSET=$${RESOLVED#* }; \
	URL="https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/download/$$TAG/$$ASSET"; \
	echo "$$TAG" > src-tauri/resources/llamacpp-backend/version.txt; \
	echo "$$BACKEND" > src-tauri/resources/llamacpp-backend/backend.txt; \
	echo "Release: $$TAG  Backend: $$BACKEND"; \
	echo "Downloading: $$URL"; \
	curl -fSL --retry 5 --retry-delay 3 "$$URL" -o /tmp/llamacpp-backend.tar.gz; \
	tar -xzf /tmp/llamacpp-backend.tar.gz -C src-tauri/resources/llamacpp-backend/; \
	rm -f /tmp/llamacpp-backend.tar.gz; \
	if [ ! -f "src-tauri/resources/llamacpp-backend/build/bin/llama-server" ]; then \
		if [ -f "src-tauri/resources/llamacpp-backend/bin/llama-server" ]; then \
			echo "Relocating bin/ → build/bin/ to match expected layout..."; \
			mkdir -p src-tauri/resources/llamacpp-backend/build; \
			mv src-tauri/resources/llamacpp-backend/bin src-tauri/resources/llamacpp-backend/build/bin; \
		elif [ -f "src-tauri/resources/llamacpp-backend/llama-server" ]; then \
			echo "Relocating flat layout → build/bin/..."; \
			mkdir -p src-tauri/resources/llamacpp-backend/build/bin; \
			find src-tauri/resources/llamacpp-backend -maxdepth 1 -type f \( -name "llama-*" -o -name "*.so" -o -name "*.so.*" \) -exec mv {} src-tauri/resources/llamacpp-backend/build/bin/ \;; \
		fi; \
	fi; \
	echo "Downloaded and extracted turboquant llamacpp backend ($$BACKEND) for Linux successfully"
else
	@echo "Skipping llamacpp backend download (unsupported platform)"
endif

# Refresh the bundled TurboQuant engine only when the fork has published a newer
# stable release. `download-llamacpp-backend-if-exists` keeps whatever archive is
# already on disk however old it is; this one compares version.txt/backend.txt
# against the newest stable release and downloads on a mismatch.
#
# On Linux the variant is the one this host would actually run
# (scripts/detect-turboquant-backend.sh mirrors the runtime probe), so a dev box
# with an NVIDIA card gets the CUDA build rather than the Vulkan fallback. That
# also means the resource dir stops holding the portable fallback a release must
# bundle — run `make download-llamacpp-backend` before packaging one.
# Examples:
#   make update-llamacpp-backend
#   make update-llamacpp-backend TURBOQUANT_BACKEND=linux-x64-rocm
update-llamacpp-backend:
ifeq ($(OS),Windows_NT)
	@echo "update-llamacpp-backend is macOS/Linux only; use download-llamacpp-backend-win-cpu."
else
	@BACKEND="$(TURBOQUANT_BACKEND)"; \
	if [ -z "$$BACKEND" ]; then BACKEND=$$($(TURBOQUANT_DETECT)) || exit 1; fi; \
	RESOLVED=$$($(TURBOQUANT_RESOLVE) "$$BACKEND" "$(TURBOQUANT_TAG)") || exit 1; \
	TAG=$${RESOLVED%% *}; \
	DIR="src-tauri/resources/llamacpp-backend"; \
	CURRENT_TAG=$$(tr -d ' \r\n' < "$$DIR/version.txt" 2>/dev/null || true); \
	CURRENT_BACKEND=$$(tr -d ' \r\n' < "$$DIR/backend.txt" 2>/dev/null || true); \
	if [ -f "$$DIR/build/bin/llama-server" ] && [ "$$CURRENT_TAG" = "$$TAG" ] && [ "$$CURRENT_BACKEND" = "$$BACKEND" ]; then \
		echo "TurboQuant $$TAG ($$BACKEND) is already the newest stable release, nothing to download."; \
	else \
		echo "Updating TurboQuant: $${CURRENT_TAG:-none}/$${CURRENT_BACKEND:-none} -> $$TAG/$$BACKEND"; \
		$(MAKE) download-llamacpp-backend TURBOQUANT_TAG="$$TAG" TURBOQUANT_BACKEND="$$BACKEND"; \
	fi
endif

# Download CPU fallback backend for Windows (pure PowerShell, no bash needed).
# Sources the official upstream ggml-org/llama.cpp release into the upstream
# backend resource dir. The app will auto-detect GPU and download the optimal
# backend (CUDA/Vulkan) at runtime via the llamacpp-upstream extension.
# Upstream remains the Windows default; this target owns its CPU fallback.
# TurboQuant uses the separate `download-llamacpp-backend-win-cpu` target.
download-llamacpp-upstream-backend-win-cpu:
	powershell -NoProfile -Command " \
		$$ErrorActionPreference = 'Stop'; \
		$$dir = 'src-tauri/resources/llamacpp-backend-upstream'; \
		if (Test-Path $$dir) { Remove-Item $$dir -Recurse -Force }; \
		New-Item -ItemType Directory -Path $$dir -Force | Out-Null; \
		$$resolved = & node scripts/resolve-upstream-backend.mjs --backend win-cpu-x64; \
		if ($$LASTEXITCODE -ne 0) { throw 'scripts/resolve-upstream-backend.mjs failed' }; \
		$$r = @{}; \
		foreach ($$line in $$resolved) { $$kv = $$line -split '=', 2; if ($$kv.Length -eq 2) { $$r[$$kv[0]] = $$kv[1] } }; \
		$$tag = $$r['TAG']; $$backend = $$r['BACKEND']; $$url = $$r['URL']; $$sha = $$r['SHA256']; \
		if (-not $$tag -or -not $$url) { throw 'resolver returned no TAG/URL' }; \
		[System.IO.File]::WriteAllText(\"$$dir/version.txt\", $$tag); \
		[System.IO.File]::WriteAllText(\"$$dir/backend.txt\", $$backend); \
		Write-Host \"Release: $$tag  Backend: $$backend\"; \
		Write-Host \"Downloading: $$url\"; \
		$$tmp = \"$$env:TEMP\\llamacpp-upstream-backend.zip\"; \
		$$ok = $$false; \
		for ($$i = 1; $$i -le 5; $$i++) { \
			try { Invoke-WebRequest -Uri $$url -OutFile $$tmp -UseBasicParsing; $$ok = $$true; break } \
			catch { Write-Host \"Download attempt $$i/5 failed: $$($$_.Exception.Message); retrying...\"; Start-Sleep -Seconds 3 } \
		}; \
		if (-not $$ok) { throw \"Failed to download $$url after 5 attempts\" }; \
		if ($$sha) { \
			$$actual = (Get-FileHash -Path $$tmp -Algorithm SHA256).Hash.ToLower(); \
			if ($$actual -ne $$sha) { Remove-Item $$tmp -Force -EA SilentlyContinue; throw \"sha256 mismatch: expected $$sha, got $$actual\" }; \
			Write-Host \"sha256 verified: $$($$r['ASSET'])\"; \
		} else { Write-Host \"No sha256 published for $$($$r['ASSET']); skipping integrity check\" }; \
		Expand-Archive -Path $$tmp -DestinationPath $$dir -Force; \
		Remove-Item $$tmp -Force -ErrorAction SilentlyContinue; \
		if (-not (Test-Path \"$$dir/build/bin/llama-server.exe\")) { \
			if (Test-Path \"$$dir/llama-server.exe\") { \
				Write-Host 'Relocating flat-extracted binaries into build/bin/...'; \
				New-Item -ItemType Directory -Path \"$$dir/build/bin\" -Force | Out-Null; \
				Get-ChildItem \"$$dir\" -File | Where-Object { $$_.Name -ne 'version.txt' -and $$_.Name -ne 'backend.txt' } | Move-Item -Destination \"$$dir/build/bin/\"; \
			} \
		}; \
		Write-Host \"CPU backend ($$backend) downloaded successfully. App will auto-download GPU backend at runtime.\"; \
	"

# Download the bundled CPU fallback for the TurboQuant provider on Windows
# (pure PowerShell, no bash needed). TurboQuant ships on Windows as the second
# provider alongside llamacpp-upstream; this target bundles the offline-fallback
# `windows-x64-cpu` build into the turboquant resource dir. The app auto-detects
# GPU and downloads the optimal CUDA/Vulkan backend at runtime via the
# llamacpp-extension. No tag is pinned: the newest stable release is resolved
# from the fork's own index.json, with the legacy atomic-chat-conf manifest as
# a fallback. Set TURBOQUANT_TAG to pin one. The archive comes from the
# AtomicBot-ai releases CDN.
download-llamacpp-backend-win-cpu:
	powershell -NoProfile -Command " \
		$$ErrorActionPreference = 'Stop'; \
		$$dir = 'src-tauri/resources/llamacpp-backend'; \
		if (Test-Path $$dir) { Remove-Item $$dir -Recurse -Force }; \
		New-Item -ItemType Directory -Path $$dir -Force | Out-Null; \
		$$headers = @{ 'User-Agent' = 'atomic-chat' }; \
		$$backend = 'windows-x64-cpu'; \
		$$tag = '$(TURBOQUANT_TAG)'; \
		$$asset = \"llama-turboquant-$${backend}.zip\"; \
		if (-not $$tag) { \
			Write-Host 'Resolving the newest stable TurboQuant release from the release index...'; \
			try { \
				$$index = Invoke-RestMethod -Uri 'https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/latest/download/index.json' -Headers $$headers; \
				$$release = $$index.releases | Where-Object { $$_.prerelease -ne $$true -and $$_.tag -match '^b[0-9]+-[0-9]+\.[0-9]+\.[0-9]+$$' -and ($$_.variants | Where-Object { $$_.id -eq $$backend }) } | Select-Object -First 1; \
				if ($$release) { \
					$$tag = $$release.tag; \
					$$variant = $$release.variants | Where-Object { $$_.id -eq $$backend } | Select-Object -First 1; \
					if ($$variant.asset) { $$asset = $$variant.asset }; \
				} \
			} catch { Write-Host 'Release index unavailable; falling back to the legacy atomic-chat-conf manifest' }; \
		}; \
		if (-not $$tag) { \
			$$manifest = Invoke-RestMethod -Uri 'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/backends/turboquant-manifest.json' -Headers $$headers; \
			$$entry = $$manifest.backends | Where-Object { $$_.id -eq $$backend } | Select-Object -First 1; \
			if (-not $$entry) { throw 'Could not resolve a stable TurboQuant windows-x64-cpu release from the release index or the legacy manifest; pass TURBOQUANT_TAG=<tag> to pin one' }; \
			$$tag = $$entry.tag; \
			$$asset = $$entry.asset; \
		}; \
		$$url = \"https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/download/$$tag/$$asset\"; \
		[System.IO.File]::WriteAllText(\"$$dir/version.txt\", $$tag); \
		[System.IO.File]::WriteAllText(\"$$dir/backend.txt\", $$backend); \
		Write-Host \"Release: $$tag  Backend: $$backend\"; \
		Write-Host \"Downloading: $$url\"; \
		$$tmp = \"$$env:TEMP\\llamacpp-turboquant-backend.zip\"; \
		$$ok = $$false; \
		for ($$i = 1; $$i -le 5; $$i++) { \
			try { Invoke-WebRequest -Uri $$url -OutFile $$tmp -UseBasicParsing; $$ok = $$true; break } \
			catch { Write-Host \"Download attempt $$i/5 failed: $$($$_.Exception.Message); retrying...\"; Start-Sleep -Seconds 3 } \
		}; \
		if (-not $$ok) { throw \"Failed to download $$url after 5 attempts\" }; \
		Expand-Archive -Path $$tmp -DestinationPath $$dir -Force; \
		Remove-Item $$tmp -Force -ErrorAction SilentlyContinue; \
		if (-not (Test-Path \"$$dir/build/bin/llama-server.exe\")) { \
			if (Test-Path \"$$dir/llama-server.exe\") { \
				Write-Host 'Relocating flat-extracted binaries into build/bin/...'; \
				New-Item -ItemType Directory -Path \"$$dir/build/bin\" -Force | Out-Null; \
				Get-ChildItem \"$$dir\" -File | Where-Object { $$_.Name -ne 'version.txt' -and $$_.Name -ne 'backend.txt' } | Move-Item -Destination \"$$dir/build/bin/\"; \
			} \
		}; \
		Write-Host \"TurboQuant CPU backend ($$backend) downloaded successfully. App will auto-download GPU backend at runtime.\"; \
	"

# Full Windows release build (local, no code signing).
# Mirrors CI pipeline from release.yml: CPU-only backend, NSIS + MSI installers.
# Output: src-tauri/target/release/bundle/nsis/*.exe
build-windows-release:
ifeq ($(OS),Windows_NT)
	powershell -ExecutionPolicy Bypass -File scripts/build-windows-release.ps1
else
	@echo "This target is for Windows only."
endif

# Download upstream ggml-org/llama.cpp backend for bundling alongside the
# turboquant fork on macOS. We ship BOTH backends in the DMG so users can pick
# the "Llama.cpp" provider (vanilla upstream) or the "llama.cpp" provider
# (TurboQuant fork) at runtime.
#
# Backend-index source (ATO-199): every branch asks
# scripts/resolve-upstream-backend.mjs for the tag, asset name, URL and hash.
# That script reads the static manifest in atomic-chat-conf
# (raw.githubusercontent.com — no per-IP rate limit), the same source the
# runtime `fetchRemoteBackends()` uses, and prefers our signed mirror over the
# ggml-org CDN. Do not re-derive any of this inline: it used to be five
# copy-pasted jq blocks, each with its own hardcoded download base.
# The manifest is the gate: a tag lands there only after the release has been
# verified, so bundling whatever it names keeps the installer and the runtime
# catalog on the same build instead of drifting apart. That replaces the
# 2026-07-03 "hold off on auto-tracking ggml-org tags" pin. Set the variable
# to bundle a different release, e.g.:
#   make download-llamacpp-upstream-backend LLAMACPP_UPSTREAM_TAG=b9222
LLAMACPP_UPSTREAM_TAG ?=
UPSTREAM_TAG_ARG = $(if $(LLAMACPP_UPSTREAM_TAG),--tag $(LLAMACPP_UPSTREAM_TAG),)

# Verifies a downloaded archive against the hash the resolver reported. An
# unmirrored tag reports none, in which case there is nothing to check and the
# build says so rather than pretending it verified something.
define verify-upstream-sha256
	if [ -n "$$SHA256" ]; then \
		ACTUAL=$$(shasum -a 256 "$(1)" | cut -d" " -f1); \
		if [ "$$ACTUAL" != "$$SHA256" ]; then \
			echo "Error: sha256 mismatch for $$ASSET"; \
			echo "  expected $$SHA256"; \
			echo "  actual   $$ACTUAL"; \
			rm -f "$(1)"; exit 1; \
		fi; \
		echo "sha256 verified: $$ASSET"; \
	else \
		echo "No sha256 published for $$ASSET; skipping integrity check"; \
	fi;
endef
download-llamacpp-upstream-backend:
ifeq ($(shell uname -s),Darwin)
	@rm -rf src-tauri/resources/llamacpp-backend-upstream
	@mkdir -p src-tauri/resources/llamacpp-backend-upstream
	@ARCH=$$(uname -m); \
	if [ "$$ARCH" = "arm64" ]; then BACKEND="macos-arm64"; else BACKEND="macos-x64"; fi; \
	echo "Platform: $$BACKEND (upstream)"; \
	RESOLVED=$$(node scripts/resolve-upstream-backend.mjs --backend "$$BACKEND" $(UPSTREAM_TAG_ARG)) || exit 1; \
	eval "$$RESOLVED"; \
	echo "$$TAG" > src-tauri/resources/llamacpp-backend-upstream/version.txt; \
	echo "$$BACKEND" > src-tauri/resources/llamacpp-backend-upstream/backend.txt; \
	echo "Release: $$TAG  Backend: $$BACKEND"; \
	echo "Downloading: $$URL"; \
	curl -fSL --retry 5 --retry-delay 3 "$$URL" -o /tmp/llamacpp-upstream-backend.tar.gz; \
	$(call verify-upstream-sha256,/tmp/llamacpp-upstream-backend.tar.gz) \
	tar -xzf /tmp/llamacpp-upstream-backend.tar.gz -C src-tauri/resources/llamacpp-backend-upstream/; \
	rm -f /tmp/llamacpp-upstream-backend.tar.gz; \
	if [ ! -f "src-tauri/resources/llamacpp-backend-upstream/build/bin/llama-server" ]; then \
		if [ -f "src-tauri/resources/llamacpp-backend-upstream/bin/llama-server" ]; then \
			echo "Relocating bin/ → build/bin/ to match expected layout..."; \
			mkdir -p src-tauri/resources/llamacpp-backend-upstream/build; \
			mv src-tauri/resources/llamacpp-backend-upstream/bin src-tauri/resources/llamacpp-backend-upstream/build/bin; \
		elif [ -f "src-tauri/resources/llamacpp-backend-upstream/llama-server" ]; then \
			echo "Relocating flat layout → build/bin/..."; \
			mkdir -p src-tauri/resources/llamacpp-backend-upstream/build/bin; \
			find src-tauri/resources/llamacpp-backend-upstream -maxdepth 1 -type f \( -name "llama-*" -o -name "*.dylib" -o -name "*.metal" \) -exec mv {} src-tauri/resources/llamacpp-backend-upstream/build/bin/ \;; \
		else \
			NESTED_DIR=$$(find src-tauri/resources/llamacpp-backend-upstream -maxdepth 1 -type d -name 'llama-*' | head -1); \
			if [ -n "$$NESTED_DIR" ] && [ -f "$$NESTED_DIR/llama-server" ]; then \
				echo "Relocating $$NESTED_DIR/ → build/bin/ ..."; \
				mkdir -p src-tauri/resources/llamacpp-backend-upstream/build/bin; \
				find "$$NESTED_DIR" -maxdepth 1 -type f -exec mv {} src-tauri/resources/llamacpp-backend-upstream/build/bin/ \;; \
				find "$$NESTED_DIR" -maxdepth 1 -type l -exec mv {} src-tauri/resources/llamacpp-backend-upstream/build/bin/ \;; \
				rmdir "$$NESTED_DIR" 2>/dev/null || rm -rf "$$NESTED_DIR"; \
			fi; \
		fi; \
	fi; \
	echo "Downloaded and extracted upstream llamacpp backend successfully"
	@# An archive from our mirror is already Developer ID signed, so re-signing
	@# it would only burn a notary timestamp round-trip per binary. The
	@# ggml-org fallback for an unmirrored tag still arrives ad-hoc signed and
	@# must be re-signed, so the loop stays — behind a check.
	@SIGNING_IDENTITY=$$(security find-identity -v -p codesigning | grep "Developer ID Application" | head -1 | sed 's/.*"\(.*\)".*/\1/'); \
	if [ -z "$$SIGNING_IDENTITY" ]; then \
		echo "Warning: No Developer ID Application identity found. Skipping code signing."; \
	else \
		TEAM_ID=$$(echo "$$SIGNING_IDENTITY" | sed -E 's/.*\(([A-Z0-9]+)\)$$/\1/'); \
		SERVER="src-tauri/resources/llamacpp-backend-upstream/build/bin/llama-server"; \
		if [ -f "$$SERVER" ] && codesign -dv "$$SERVER" 2>&1 | grep -q "TeamIdentifier=$$TEAM_ID"; then \
			echo "Backend is already signed by team $$TEAM_ID (mirrored build); skipping re-signing"; \
		else \
			echo "Signing upstream llamacpp backend binaries..."; \
			for bin in src-tauri/resources/llamacpp-backend-upstream/build/bin/*; do \
				if [ -f "$$bin" ] && file "$$bin" | grep -q "Mach-O"; then \
					codesign --force --options runtime --timestamp --entitlements src-tauri/Entitlements.plist --sign "$$SIGNING_IDENTITY" "$$bin"; \
				fi; \
			done; \
			echo "Code signing completed"; \
		fi; \
	fi
else ifeq ($(OS),Windows_NT)
	@mkdir -p src-tauri/resources/llamacpp-backend-upstream
	@echo "Detecting GPU and selecting best upstream backend for Windows..."; \
	BACKEND=""; \
	if [ -n "$(LLAMACPP_BACKEND)" ]; then \
		BACKEND="$(LLAMACPP_BACKEND)"; \
		echo "Using manually specified backend: $$BACKEND"; \
	else \
		NV_DRIVER=$$(powershell -NoProfile -Command "try { $$g = Get-CimInstance Win32_VideoController -EA Stop | Where-Object { $$_.Name -match 'NVIDIA' } | Select-Object -First 1; if($$g -and $$g.DriverVersion){ $$r = $$g.DriverVersion -replace '\\.','' ; if($$r.Length -ge 5){ $$nv=$$r.Substring($$r.Length-5); $$maj=$$nv.Substring(0,3).TrimStart('0'); $$min=$$nv.Substring(3,2); if(-not $$maj){$$maj='0'}; Write-Output \"$$maj.$$min\" } } } catch {}" 2>/dev/null); \
		HAS_VULKAN=$$(powershell -NoProfile -Command "if(Test-Path \"$$env:SystemRoot\\System32\\vulkan-1.dll\"){'true'}else{'false'}" 2>/dev/null); \
		VRAM_MIB=$$(powershell -NoProfile -Command "try{ $$v=(Get-CimInstance Win32_VideoController -EA Stop | ForEach-Object { $$_.AdapterRAM } | Sort-Object -Descending | Select-Object -First 1); if($$v -gt 0){[math]::Floor($$v/1048576)}else{0} } catch { 0 }" 2>/dev/null); \
		echo "NVIDIA driver: $${NV_DRIVER:-none}  Vulkan: $$HAS_VULKAN  VRAM: $${VRAM_MIB:-0} MiB"; \
		if [ -n "$$NV_DRIVER" ]; then \
			NV_MAJOR=$$(echo "$$NV_DRIVER" | cut -d. -f1); \
			NV_MINOR=$$(echo "$$NV_DRIVER" | cut -d. -f2); \
			NV_VAL=$$((NV_MAJOR * 100 + NV_MINOR)); \
			if [ $$NV_VAL -ge 58115 ]; then \
				BACKEND="win-cuda-13-x64"; \
			elif [ $$NV_VAL -ge 55161 ]; then \
				BACKEND="win-cuda-12-x64"; \
			fi; \
		fi; \
		if [ -z "$$BACKEND" ] && [ "$$HAS_VULKAN" = "true" ] && [ "$${VRAM_MIB:-0}" -ge 6144 ]; then \
			BACKEND="win-vulkan-x64"; \
		fi; \
		if [ -z "$$BACKEND" ]; then \
			BACKEND="win-cpu-x64"; \
		fi; \
		echo "Auto-selected backend: $$BACKEND"; \
	fi; \
	RESOLVED=$$(node scripts/resolve-upstream-backend.mjs --backend "$$BACKEND") || exit 1; \
	eval "$$RESOLVED"; \
	echo "$$TAG" > src-tauri/resources/llamacpp-backend-upstream/version.txt; \
	echo "$$BACKEND" > src-tauri/resources/llamacpp-backend-upstream/backend.txt; \
	echo "Release: $$TAG  Backend: $$BACKEND"; \
	echo "Downloading: $$URL"; \
	curl -fSL --retry 5 --retry-delay 3 "$$URL" -o /tmp/llamacpp-upstream-backend.zip; \
	$(call verify-upstream-sha256,/tmp/llamacpp-upstream-backend.zip) \
	unzip -o /tmp/llamacpp-upstream-backend.zip -d src-tauri/resources/llamacpp-backend-upstream/; \
	rm -f /tmp/llamacpp-upstream-backend.zip; \
	if [ ! -f "src-tauri/resources/llamacpp-backend-upstream/build/bin/llama-server.exe" ]; then \
		if [ -f "src-tauri/resources/llamacpp-backend-upstream/llama-server.exe" ]; then \
			echo "Relocating flat-extracted binaries into build/bin/..."; \
			mkdir -p src-tauri/resources/llamacpp-backend-upstream/build/bin; \
			mv src-tauri/resources/llamacpp-backend-upstream/*.exe src-tauri/resources/llamacpp-backend-upstream/build/bin/; \
			mv src-tauri/resources/llamacpp-backend-upstream/*.dll src-tauri/resources/llamacpp-backend-upstream/build/bin/ 2>/dev/null || true; \
		fi; \
	fi; \
	powershell -NoProfile -ExecutionPolicy Bypass -File scripts/download-llamacpp-cudart-windows.ps1 \
		-BackendDir src-tauri/resources/llamacpp-backend-upstream -Backend "$$BACKEND" -Tag "$$TAG" || \
		echo "Warning: cudart merge failed for $$BACKEND (GPU detection may not work)"; \
	echo "Downloaded and extracted upstream llamacpp backend ($$BACKEND) for Windows successfully"
else ifeq ($(shell uname -s),Linux)
	@mkdir -p src-tauri/resources/llamacpp-backend-upstream
	@# Upstream remains the Linux default and bundles its CPU-only build.
	@# NVIDIA / AMD / Intel users
	@# get `linux-vulkan-x64` at runtime through the "Find optimal
	@# backend" flow — we deliberately do NOT auto-detect GPU at build
	@# time, since the bundled artefact is meant to be the offline
	@# fallback that works on any host.
	@BACKEND="linux-cpu-x64"; \
	echo "Platform: $$BACKEND (upstream / Linux)"; \
	RESOLVED=$$(node scripts/resolve-upstream-backend.mjs --backend "$$BACKEND" $(UPSTREAM_TAG_ARG)) || exit 1; \
	eval "$$RESOLVED"; \
	echo "$$TAG" > src-tauri/resources/llamacpp-backend-upstream/version.txt; \
	echo "$$BACKEND" > src-tauri/resources/llamacpp-backend-upstream/backend.txt; \
	echo "Release: $$TAG  Backend: $$BACKEND"; \
	echo "Downloading: $$URL"; \
	curl -fSL --retry 5 --retry-delay 3 "$$URL" -o /tmp/llamacpp-upstream-backend.tar.gz; \
	$(call verify-upstream-sha256,/tmp/llamacpp-upstream-backend.tar.gz) \
	tar -xzf /tmp/llamacpp-upstream-backend.tar.gz -C src-tauri/resources/llamacpp-backend-upstream/; \
	rm -f /tmp/llamacpp-upstream-backend.tar.gz; \
	if [ ! -f "src-tauri/resources/llamacpp-backend-upstream/build/bin/llama-server" ]; then \
		if [ -f "src-tauri/resources/llamacpp-backend-upstream/bin/llama-server" ]; then \
			echo "Relocating bin/ → build/bin/ to match expected layout..."; \
			mkdir -p src-tauri/resources/llamacpp-backend-upstream/build; \
			mv src-tauri/resources/llamacpp-backend-upstream/bin src-tauri/resources/llamacpp-backend-upstream/build/bin; \
		elif [ -f "src-tauri/resources/llamacpp-backend-upstream/llama-server" ]; then \
			echo "Relocating flat layout → build/bin/..."; \
			mkdir -p src-tauri/resources/llamacpp-backend-upstream/build/bin; \
			find src-tauri/resources/llamacpp-backend-upstream -maxdepth 1 -type f \( -name "llama-*" -o -name "*.so" -o -name "*.so.*" \) -exec mv {} src-tauri/resources/llamacpp-backend-upstream/build/bin/ \;; \
		else \
			NESTED_DIR=$$(find src-tauri/resources/llamacpp-backend-upstream -maxdepth 1 -type d -name 'llama-*' -o -name 'build' | head -1); \
			if [ -n "$$NESTED_DIR" ] && [ -f "$$NESTED_DIR/llama-server" ]; then \
				echo "Relocating $$NESTED_DIR/ → build/bin/ ..."; \
				mkdir -p src-tauri/resources/llamacpp-backend-upstream/build/bin; \
				find "$$NESTED_DIR" -maxdepth 1 -type f -exec mv {} src-tauri/resources/llamacpp-backend-upstream/build/bin/ \;; \
				find "$$NESTED_DIR" -maxdepth 1 -type l -exec mv {} src-tauri/resources/llamacpp-backend-upstream/build/bin/ \;; \
				rmdir "$$NESTED_DIR" 2>/dev/null || rm -rf "$$NESTED_DIR"; \
			fi; \
		fi; \
	fi; \
	echo "Downloaded and extracted upstream llamacpp backend ($$BACKEND) for Linux successfully"
else
	@echo "Skipping upstream llamacpp backend download (macOS / Windows / Linux only)"
endif

# Convenience target: explicitly download the Linux CPU-only upstream
# backend. Mirrors `download-llamacpp-upstream-backend-win-cpu`. Useful
# for CI jobs that want to be explicit about the artefact they bundle.
download-llamacpp-upstream-backend-linux-cpu:
	@$(MAKE) download-llamacpp-upstream-backend

# Download upstream llamacpp backend only if not already present (for dev)
download-llamacpp-upstream-backend-if-exists:
ifeq ($(shell uname -s),Darwin)
	@if [ -f "src-tauri/resources/llamacpp-backend-upstream/build/bin/llama-server" ]; then \
		echo "upstream llamacpp backend already exists, skipping download..."; \
	else \
		$(MAKE) download-llamacpp-upstream-backend; \
	fi
else ifeq ($(OS),Windows_NT)
ifneq ($(wildcard src-tauri/resources/llamacpp-backend-upstream/build/bin/llama-server.exe),)
	@echo "upstream llamacpp backend already exists, skipping download..."
else
	$(MAKE) download-llamacpp-upstream-backend
endif
else ifeq ($(shell uname -s),Linux)
	@if [ -f "src-tauri/resources/llamacpp-backend-upstream/build/bin/llama-server" ]; then \
		echo "upstream llamacpp backend already exists, skipping download..."; \
	else \
		$(MAKE) download-llamacpp-upstream-backend; \
	fi
else
	@echo "Skipping upstream llamacpp backend (macOS / Windows / Linux only)"
endif

# Download llamacpp backend only if not already present (for dev)
download-llamacpp-backend-if-exists:
ifeq ($(shell uname -s),Darwin)
	@if [ -f "src-tauri/resources/llamacpp-backend/build/bin/llama-server" ]; then \
		echo "llamacpp backend already exists, skipping download..."; \
	else \
		$(MAKE) download-llamacpp-backend; \
	fi
else ifeq ($(OS),Windows_NT)
	@echo "download-llamacpp-backend-if-exists is a no-op on Windows."
	@echo "Release packaging installs TurboQuant separately; use the upstream dev target for the default provider."
else
	@echo "Skipping llamacpp backend (unsupported platform)"
endif

# The bundled `jan-cli` is the compiled atomic-chat-core (the legacy Rust CLI was removed in stage 6).

# Fetch the pinned core release (or use ATOMIC_CORE_LOCAL) into resources/bin.
download-core:
	node ./scripts/download-core.mjs

# Copy the core into place as `jan-cli` and sign it. The file name is the contract the installer,
# the Settings → Install CLI action and every doc already use; only its contents change.
build-cli-core: download-core
	@node ./scripts/download-core.mjs --verify-only
ifeq ($(shell uname -s),Darwin)
	cp src-tauri/resources/bin/atomic-chat-core src-tauri/resources/bin/jan-cli
	chmod +x src-tauri/resources/bin/jan-cli
	mkdir -p src-tauri/target/universal-apple-darwin/release
	@echo "Checking for code signing identity..."; \
	SIGNING_IDENTITY=$$(security find-identity -v -p codesigning | grep "Developer ID Application" | head -1 | sed 's/.*"\(.*\)".*/\1/'); \
	if [ -n "$$SIGNING_IDENTITY" ]; then \
		for binary in jan-cli atomic-chat-core atomic-chat-app-core; do \
			echo "Signing $$binary with identity: $$SIGNING_IDENTITY"; \
			codesign --force --options runtime --timestamp --entitlements src-tauri/Entitlements.sidecar.plist --sign "$$SIGNING_IDENTITY" "src-tauri/resources/bin/$$binary" || exit 1; \
			codesign --verify --strict --verbose=2 "src-tauri/resources/bin/$$binary" || exit 1; \
		done; \
	else \
		echo "Warning: No Developer ID Application identity found. Skipping code signing (notarization will fail)."; \
	fi
	cp src-tauri/resources/bin/jan-cli src-tauri/target/universal-apple-darwin/release/jan-cli
else ifeq ($(OS),Windows_NT)
	powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path 'src-tauri/resources/bin' | Out-Null; Copy-Item 'src-tauri/resources/bin/atomic-chat-core.exe' 'src-tauri/resources/bin/jan-cli.exe' -Force"
else
	cp src-tauri/resources/bin/atomic-chat-core src-tauri/resources/bin/jan-cli
	chmod +x src-tauri/resources/bin/jan-cli
endif

build-cli:
	"$(MAKE)" build-cli-core

# Debug build for local dev (faster, native arch only)
build-cli-dev:
	"$(MAKE)" build-cli-core

# Build
build: install-and-build install-rust-targets
	yarn build

# ──────────────────────────────────────────────────────────────
# macOS release build: universal .app + .dmg with the version in VOLNAME
# ──────────────────────────────────────────────────────────────
# Steps:
#   1. yarn tauri build (universal-apple-darwin, macOS config)
#      — Tauri signs and notarizes the .app, creates and signs the .dmg
#   2. scripts/rename-dmg-volume.sh
#      — renames the DMG volume to "Atomic Chat v<version>"
#      — breaks only the DMG container signature; the .app inside stays notarized
#   3. scripts/notarize-dmg-macos.sh
#      — restores the DMG signature + notarizes + staples (if APPLE_ID/PASSWORD/TEAM_ID are set)
#
# For a local build `make build-mac` is enough; notarization is skipped
# automatically when Apple credentials are absent from the environment.
build-mac:
ifeq ($(shell uname -s),Darwin)
	yarn tauri build --target universal-apple-darwin --config src-tauri/tauri.macos.conf.json
	@DMG=$$(ls -t src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.dmg 2>/dev/null | head -1); \
	if [ -z "$$DMG" ] || [ ! -f "$$DMG" ]; then \
		echo "Error: DMG not found after tauri build"; \
		exit 1; \
	fi; \
	echo "=== DMG located: $$DMG ==="; \
	bash scripts/rename-dmg-volume.sh "$$DMG"; \
	SIGNING_IDENTITY=$${APPLE_SIGNING_IDENTITY:-$$(security find-identity -v -p codesigning 2>/dev/null | grep "Developer ID Application" | head -1 | sed -n 's/.*"\(.*\)".*/\1/p')}; \
	if [ -n "$$SIGNING_IDENTITY" ]; then \
		bash scripts/notarize-dmg-macos.sh "$$DMG"; \
	else \
		echo "Warning: no Developer ID Application identity found — skipping DMG re-sign/notarize."; \
		echo "Note: DMG volume was renamed but container signature is broken. Set APPLE_SIGNING_IDENTITY or install cert to fix."; \
	fi
else
	@echo "build-mac is macOS-only"
	@exit 1
endif

clean:
ifeq ($(OS),Windows_NT)
	-powershell -Command "Get-ChildItem -Path . -Include node_modules, .next, dist, build, out, .turbo, .yarn -Recurse -Directory | Remove-Item -Recurse -Force"
	-powershell -Command "Get-ChildItem -Path . -Include package-lock.json, tsconfig.tsbuildinfo -Recurse -File | Remove-Item -Recurse -Force"
	-powershell -Command "Remove-Item -Recurse -Force ./pre-install/*.tgz"
	-powershell -Command "Remove-Item -Recurse -Force ./extensions/*/*.tgz"
	-powershell -Command "Remove-Item -Recurse -Force ./electron/pre-install/*.tgz"
	-powershell -Command "Remove-Item -Recurse -Force ./src-tauri/resources"
	-powershell -Command "Remove-Item -Recurse -Force ./src-tauri/target"
	-powershell -Command "if (Test-Path \"$($env:USERPROFILE)\jan\extensions\") { Remove-Item -Path \"$($env:USERPROFILE)\jan\extensions\" -Recurse -Force }"
else ifeq ($(shell uname -s),Linux)
	find . -name "node_modules" -type d -prune -exec rm -rf '{}' +
	find . -name ".next" -type d -exec rm -rf '{}' +
	find . -name "dist" -type d -exec rm -rf '{}' +
	find . -name "build" -type d -exec rm -rf '{}' +
	find . -name "out" -type d -exec rm -rf '{}' +
	find . -name ".turbo" -type d -exec rm -rf '{}' +
	find . -name ".yarn" -type d -exec rm -rf '{}' +
	find . -name "packake-lock.json" -type f -exec rm -rf '{}' +
	find . -name "package-lock.json" -type f -exec rm -rf '{}' +
	rm -rf ./pre-install/*.tgz
	rm -rf ./extensions/*/*.tgz
	rm -rf ./electron/pre-install/*.tgz
	rm -rf ./src-tauri/resources
	rm -rf ./src-tauri/target
	rm -rf "~/jan/extensions"
	rm -rf "~/.cache/jan*"
	rm -rf "./.cache"
else
	find . -name "node_modules" -type d -prune -exec rm -rfv '{}' +
	find . -name ".next" -type d -exec rm -rfv '{}' +
	find . -name "dist" -type d -exec rm -rfv '{}' +
	find . -name "build" -type d -exec rm -rfv '{}' +
	find . -name "out" -type d -exec rm -rfv '{}' +
	find . -name ".turbo" -type d -exec rm -rfv '{}' +
	find . -name ".yarn" -type d -exec rm -rfv '{}' +
	find . -name "package-lock.json" -type f -exec rm -rfv '{}' +
	rm -rfv ./pre-install/*.tgz
	rm -rfv ./extensions/*/*.tgz
	rm -rfv ./electron/pre-install/*.tgz
	rm -rfv ./src-tauri/resources
	rm -rfv ./src-tauri/target
	rm -rfv ~/jan/extensions
	rm -rfv ~/Library/Caches/jan*
endif
