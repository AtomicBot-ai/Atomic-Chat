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

dev: install-and-build
	yarn download:bin
	make download-llamacpp-backend
	make build-mlx-server
	make build-foundation-models-server-if-exists
	make build-cli-dev
	yarn dev

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
test: lint install-rust-targets
	yarn download:bin
ifeq ($(OS),Windows_NT)
endif
	yarn test
	yarn copy:assets:tauri
	yarn build:icon
	yarn build:mlx-server
	make build-foundation-models-server-if-exists
	make build-cli
	cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --features test-tauri -- --test-threads=1
	cargo test --manifest-path src-tauri/plugins/tauri-plugin-hardware/Cargo.toml
	cargo test --manifest-path src-tauri/plugins/tauri-plugin-llamacpp/Cargo.toml
	cargo test --manifest-path src-tauri/utils/Cargo.toml

# Download DFlash MLX server binary from GitHub releases (macOS only)
# Supports GH_TOKEN env var for authenticated GitHub API requests (avoids rate limits in CI)
# Override DFLASH_TAG to pin a specific release, e.g.:
#   make build-mlx-server DFLASH_TAG=dflash-macos-arm64-abc1234
DFLASH_TAG ?=
build-mlx-server:
ifeq ($(shell uname -s),Darwin)
	@mkdir -p src-tauri/resources/bin
	@echo "Downloading DFlash MLX server binary..."; \
	if [ -n "$(DFLASH_TAG)" ]; then \
		TAG="$(DFLASH_TAG)"; \
		echo "Using pinned release: $$TAG"; \
	else \
		echo "Fetching latest DFlash release..."; \
		API_URL="https://api.github.com/repos/AtomicBot-ai/dflash/releases"; \
		TMPREL=$$(mktemp /tmp/dflash-releases-XXXXXX.json); \
		if [ -n "$$GH_TOKEN" ]; then \
			curl -sf -H "Authorization: Bearer $$GH_TOKEN" "$$API_URL" -o "$$TMPREL"; \
		else \
			curl -sf "$$API_URL" -o "$$TMPREL"; \
		fi; \
		if [ ! -s "$$TMPREL" ]; then rm -f "$$TMPREL"; echo "Error: Failed to fetch releases from GitHub API"; exit 1; fi; \
		if command -v jq >/dev/null 2>&1; then \
			TAG=$$(jq -r '[.[] | select(.tag_name | startswith("dflash-macos-arm64"))][0].tag_name // empty' "$$TMPREL"); \
		else \
			TAG=$$(python3 -c "import sys,json; rs=json.load(open(sys.argv[1])); ts=[r for r in rs if r['tag_name'].startswith('dflash-macos-arm64')]; print(ts[0]['tag_name'] if ts else '')" "$$TMPREL" 2>/dev/null); \
		fi; \
		rm -f "$$TMPREL"; \
		if [ -z "$$TAG" ]; then echo "Error: No DFlash release found"; exit 1; fi; \
	fi; \
	echo "Release: $$TAG"; \
	URL="https://github.com/AtomicBot-ai/dflash/releases/download/$$TAG/dflash-mlx-server-macos-arm64.tar.gz"; \
	echo "Downloading: $$URL"; \
	curl -fSL "$$URL" -o /tmp/dflash-mlx-server.tar.gz; \
	tar -xzf /tmp/dflash-mlx-server.tar.gz -C src-tauri/resources/bin/; \
	rm -f /tmp/dflash-mlx-server.tar.gz; \
	chmod +x src-tauri/resources/bin/mlx-server; \
	echo "$$TAG" > src-tauri/resources/bin/mlx-server-version.txt; \
	echo "macos-arm64" > src-tauri/resources/bin/mlx-server-backend.txt; \
	echo "DFlash MLX server downloaded and extracted successfully ($$TAG)"
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

# Download MLX server if missing, outdated, or a leftover Swift binary.
# Compares local version tag with the latest GitHub release.
build-mlx-server-if-exists:
ifeq ($(shell uname -s),Darwin)
	@if [ ! -f "src-tauri/resources/bin/mlx-server" ] || [ ! -f "src-tauri/resources/bin/mlx-server-version.txt" ]; then \
		echo "MLX server binary or version file missing — downloading..."; \
		make build-mlx-server; \
	else \
		LOCAL_TAG=$$(cat src-tauri/resources/bin/mlx-server-version.txt 2>/dev/null); \
		API_URL="https://api.github.com/repos/AtomicBot-ai/dflash/releases"; \
		if [ -n "$$GH_TOKEN" ]; then \
			LATEST_TAG=$$(curl -sf -H "Authorization: Bearer $$GH_TOKEN" "$$API_URL" | python3 -c "import sys,json; rs=json.load(sys.stdin); ts=[r for r in rs if r['tag_name'].startswith('dflash-macos-arm64')]; print(ts[0]['tag_name'] if ts else '')" 2>/dev/null); \
		else \
			LATEST_TAG=$$(curl -sf "$$API_URL" | python3 -c "import sys,json; rs=json.load(sys.stdin); ts=[r for r in rs if r['tag_name'].startswith('dflash-macos-arm64')]; print(ts[0]['tag_name'] if ts else '')" 2>/dev/null); \
		fi; \
		if [ -z "$$LATEST_TAG" ]; then \
			echo "Could not fetch latest release tag — keeping current ($$LOCAL_TAG)"; \
		elif [ "$$LOCAL_TAG" = "$$LATEST_TAG" ]; then \
			echo "MLX server is up-to-date ($$LOCAL_TAG)"; \
		else \
			echo "MLX server outdated: local=$$LOCAL_TAG remote=$$LATEST_TAG — updating..."; \
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

# Download llamacpp turboquant backend for bundling
# Supports GH_TOKEN env var for authenticated GitHub API requests (avoids rate limits in CI)
# Override LLAMACPP_TAG to pin a specific release, e.g.:
#   make download-llamacpp-backend LLAMACPP_TAG=turboquant-macos-arm64-7c01058
LLAMACPP_TAG ?=
download-llamacpp-backend:
ifeq ($(shell uname -s),Darwin)
	@mkdir -p src-tauri/resources/llamacpp-backend
	@ARCH=$$(uname -m); \
	if [ "$$ARCH" = "arm64" ]; then BACKEND="macos-arm64"; else BACKEND="macos-x64"; fi; \
	echo "Platform: $$BACKEND"; \
	if [ -n "$(LLAMACPP_TAG)" ]; then \
		TAG="$(LLAMACPP_TAG)"; \
		echo "Using pinned release: $$TAG"; \
	else \
		echo "Fetching latest llamacpp turboquant release..."; \
		TMPREL=$$(mktemp /tmp/llamacpp-releases-XXXXXX.json); \
		API_URL="https://api.github.com/repos/AtomicBot-ai/atomic-llama-cpp-turboquant/releases"; \
		if [ -n "$$GH_TOKEN" ]; then \
			curl -sf -H "Authorization: Bearer $$GH_TOKEN" "$$API_URL" -o "$$TMPREL"; \
		else \
			curl -sf "$$API_URL" -o "$$TMPREL"; \
		fi; \
		if [ ! -s "$$TMPREL" ]; then rm -f "$$TMPREL"; echo "Error: Failed to fetch releases from GitHub API"; exit 1; fi; \
		if command -v jq >/dev/null 2>&1; then \
			TAG=$$(jq -r --arg b "$$BACKEND" '[.[] | select(.tag_name | startswith("turboquant-" + $$b))][0].tag_name // empty' "$$TMPREL"); \
			if [ -z "$$TAG" ]; then \
				echo "No turboquant release found for $$BACKEND, trying legacy release..."; \
				TAG=$$(jq -r '[.[] | select(.tag_name | startswith("turboquant-") | not)][0].tag_name // empty' "$$TMPREL"); \
			fi; \
		else \
			TAG=$$(python3 -c "import sys,json; rs=json.load(open(sys.argv[2])); ts=[r for r in rs if r['tag_name'].startswith('turboquant-'+sys.argv[1])]; print(ts[0]['tag_name'] if ts else '')" "$$BACKEND" "$$TMPREL" 2>/dev/null); \
			if [ -z "$$TAG" ]; then \
				echo "No turboquant release found for $$BACKEND, trying legacy release..."; \
				TAG=$$(python3 -c "import sys,json; rs=json.load(open(sys.argv[1])); lg=[r for r in rs if not r['tag_name'].startswith('turboquant-')]; print(lg[0]['tag_name'] if lg else '')" "$$TMPREL" 2>/dev/null); \
			fi; \
		fi; \
		rm -f "$$TMPREL"; \
		if [ -z "$$TAG" ]; then echo "Error: No release found"; exit 1; fi; \
	fi; \
	echo "Release: $$TAG"; \
	case "$$TAG" in \
		turboquant-*) URL="https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/download/$$TAG/llama-turboquant-$$BACKEND.tar.gz" ;; \
		*) URL="https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/download/$$TAG/llama-$$TAG-bin-$$BACKEND.tar.gz" ;; \
	esac; \
	echo "$$TAG" > src-tauri/resources/llamacpp-backend/version.txt; \
	echo "$$BACKEND" > src-tauri/resources/llamacpp-backend/backend.txt; \
	echo "Downloading: $$URL"; \
	curl -fSL "$$URL" -o /tmp/llamacpp-backend.tar.gz; \
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
	@mkdir -p src-tauri/resources/llamacpp-backend
	@echo "Detecting GPU and selecting best backend for Windows..."; \
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
			if [ $$NV_VAL -ge 58000 ]; then \
				BACKEND="win-cuda-13-common_cpus-x64"; \
			elif [ $$NV_VAL -ge 52741 ]; then \
				BACKEND="win-cuda-12-common_cpus-x64"; \
			elif [ $$NV_VAL -ge 45239 ]; then \
				BACKEND="win-cuda-11-common_cpus-x64"; \
			fi; \
		fi; \
		if [ -z "$$BACKEND" ] && [ "$$HAS_VULKAN" = "true" ] && [ "$${VRAM_MIB:-0}" -ge 6144 ]; then \
			BACKEND="win-vulkan-common_cpus-x64"; \
		fi; \
		if [ -z "$$BACKEND" ]; then \
			BACKEND="win-common_cpus-x64"; \
		fi; \
		echo "Auto-selected backend: $$BACKEND"; \
	fi; \
	echo "Fetching latest llamacpp release from janhq/llama.cpp..."; \
	API_URL="https://api.github.com/repos/janhq/llama.cpp/releases/latest"; \
	if [ -n "$$GH_TOKEN" ]; then \
		TAG=$$(curl -sf -H "Authorization: Bearer $$GH_TOKEN" "$$API_URL" | jq -r '.tag_name'); \
	else \
		TAG=$$(curl -sf "$$API_URL" | jq -r '.tag_name'); \
	fi; \
	if [ -z "$$TAG" ] || [ "$$TAG" = "null" ]; then echo "Error: Failed to fetch latest release tag"; exit 1; fi; \
	URL="https://github.com/janhq/llama.cpp/releases/download/$$TAG/llama-$$TAG-bin-$$BACKEND.tar.gz"; \
	echo "$$TAG" > src-tauri/resources/llamacpp-backend/version.txt; \
	echo "$$BACKEND" > src-tauri/resources/llamacpp-backend/backend.txt; \
	echo "Release: $$TAG  Backend: $$BACKEND"; \
	echo "Downloading: $$URL"; \
	curl -fSL "$$URL" -o /tmp/llamacpp-backend.tar.gz; \
	tar -xzf /tmp/llamacpp-backend.tar.gz -C src-tauri/resources/llamacpp-backend/; \
	rm -f /tmp/llamacpp-backend.tar.gz; \
	if [ ! -f "src-tauri/resources/llamacpp-backend/build/bin/llama-server.exe" ]; then \
		if [ -f "src-tauri/resources/llamacpp-backend/llama-server.exe" ]; then \
			echo "Relocating flat-extracted binaries into build/bin/..."; \
			mkdir -p src-tauri/resources/llamacpp-backend/build/bin; \
			mv src-tauri/resources/llamacpp-backend/*.exe src-tauri/resources/llamacpp-backend/build/bin/; \
			mv src-tauri/resources/llamacpp-backend/*.dll src-tauri/resources/llamacpp-backend/build/bin/ 2>/dev/null || true; \
		fi; \
	fi; \
	echo "Downloaded and extracted llamacpp backend ($$BACKEND) for Windows successfully"
else
	@echo "Skipping llamacpp backend download (unsupported platform)"
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
	@if [ -f "src-tauri/resources/llamacpp-backend/build/bin/llama-server.exe" ]; then \
		echo "llamacpp backend already exists, skipping download..."; \
	else \
		$(MAKE) download-llamacpp-backend; \
	fi
else
	@echo "Skipping llamacpp backend (unsupported platform)"
endif

# Build jan CLI (release, platform-aware) → src-tauri/resources/bin/jan[.exe]
build-cli:
ifeq ($(shell uname -s),Darwin)
	cd src-tauri && cargo build --release --features cli --bin jan-cli --target aarch64-apple-darwin
	cd src-tauri && cargo build --release --features cli --bin jan-cli --target x86_64-apple-darwin
	lipo -create \
		src-tauri/target/aarch64-apple-darwin/release/jan-cli \
		src-tauri/target/x86_64-apple-darwin/release/jan-cli \
		-output src-tauri/resources/bin/jan-cli
	chmod +x src-tauri/resources/bin/jan-cli
	mkdir -p src-tauri/target/universal-apple-darwin/release

	echo "Checking for code signing identity..."; \
	SIGNING_IDENTITY=$$(security find-identity -v -p codesigning | grep "Developer ID Application" | head -1 | sed 's/.*"\(.*\)".*/\1/'); \
	if [ -n "$$SIGNING_IDENTITY" ]; then \
		echo "Signing jan-cli with identity: $$SIGNING_IDENTITY"; \
		codesign --force --options runtime --timestamp --sign "$$SIGNING_IDENTITY" src-tauri/resources/bin/jan-cli; \
		echo "Code signing completed successfully"; \
	else \
		echo "Warning: No Developer ID Application identity found. Skipping code signing (notarization will fail)."; \
	fi

	cp src-tauri/resources/bin/jan-cli src-tauri/target/universal-apple-darwin/release/jan-cli
else ifeq ($(OS),Windows_NT)
	cd src-tauri && cargo build --release --features cli --bin jan-cli
	cp src-tauri/target/release/jan-cli.exe src-tauri/resources/bin/jan-cli.exe
else
	cd src-tauri && cargo build --release --features cli --bin jan-cli
	cp src-tauri/target/release/jan-cli src-tauri/resources/bin/jan-cli
endif

# Debug build for local dev (faster, native arch only)
build-cli-dev:
	mkdir -p src-tauri/resources/bin
	cd src-tauri && cargo build --features cli --bin jan-cli
ifeq ($(OS),Windows_NT)
	cp src-tauri/target/debug/jan-cli.exe src-tauri/resources/bin/jan-cli.exe
else
	install -m755 src-tauri/target/debug/jan-cli src-tauri/resources/bin/jan-cli
endif

# Build
build: install-and-build install-rust-targets
	yarn build

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
