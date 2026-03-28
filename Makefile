# Makefile for Jan Electron App - Build, Lint, Test, and Clean

REPORT_PORTAL_URL ?= ""
REPORT_PORTAL_API_KEY ?= ""
REPORT_PORTAL_PROJECT_NAME ?= ""
REPORT_PORTAL_LAUNCH_NAME ?= "Jan App"
REPORT_PORTAL_DESCRIPTION ?= "Jan App report"

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
	make build-mlx-server-if-exists
	make build-foundation-models-server-if-exists
	make build-cli-dev
	yarn dev

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

# Build MLX server (macOS Apple Silicon only) - always builds
build-mlx-server:
ifeq ($(shell uname -s),Darwin)
	@echo "Building MLX server for Apple Silicon..."
	cd mlx-server && swift build -c release
	@echo "Copying build products..."
	@BUILD_DIR=$$(cd mlx-server && swift build -c release --show-bin-path); \
	if [ -z "$$BUILD_DIR" ]; then \
		echo "Error: Could not find build products"; \
		exit 1; \
	fi; \
	mkdir -p src-tauri/resources/bin; \
	echo "Copying mlx-server from $$BUILD_DIR..."; \
	cp "$$BUILD_DIR/mlx-server" src-tauri/resources/bin/mlx-server; \
	if [ -d "$$BUILD_DIR/mlx-swift_Cmlx.bundle" ]; then \
		cp -r "$$BUILD_DIR/mlx-swift_Cmlx.bundle" src-tauri/resources/bin/; \
	else \
		mkdir -p src-tauri/resources/bin/mlx-swift_Cmlx.bundle; \
	fi; \
	chmod +x src-tauri/resources/bin/mlx-server; \
	echo "MLX server built and copied successfully"; \
	echo "Checking for code signing identity..."; \
	SIGNING_IDENTITY=$$(security find-identity -v -p codesigning | grep "Developer ID Application" | head -1 | sed 's/.*"\(.*\)".*/\1/'); \
	if [ -n "$$SIGNING_IDENTITY" ]; then \
		echo "Signing mlx-server with identity: $$SIGNING_IDENTITY"; \
		codesign --force --options runtime --timestamp --sign "$$SIGNING_IDENTITY" src-tauri/resources/bin/mlx-server; \
		if [ -d "src-tauri/resources/bin/mlx-swift_Cmlx.bundle" ]; then \
			echo "Signing mlx-swift_Cmlx.bundle..."; \
			codesign --force --options runtime --timestamp --sign "$$SIGNING_IDENTITY" --deep src-tauri/resources/bin/mlx-swift_Cmlx.bundle; \
		fi; \
		echo "Code signing completed successfully"; \
	else \
		echo "Warning: No Developer ID Application identity found. Skipping code signing (notarization will fail)."; \
	fi
else
	@echo "Skipping MLX server build (macOS only)"
endif

# Build MLX server only if not already present (for dev)
build-mlx-server-if-exists:
ifeq ($(shell uname -s),Darwin)
	@if [ -f "src-tauri/resources/bin/mlx-server" ]; then \
		echo "MLX server already exists at src-tauri/resources/bin/mlx-server, skipping build..."; \
	else \
		make build-mlx-server; \
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

# Download latest llamacpp turboquant backend for bundling
# Supports GH_TOKEN env var for authenticated GitHub API requests (avoids rate limits in CI)
download-llamacpp-backend:
ifeq ($(shell uname -s),Darwin)
	@echo "Downloading latest llamacpp turboquant backend for macOS..."
	@mkdir -p src-tauri/resources/llamacpp-backend
	@ARCH=$$(uname -m); \
	if [ "$$ARCH" = "arm64" ]; then BACKEND="macos-arm64"; else BACKEND="macos-x64"; fi; \
	echo "Platform: $$BACKEND"; \
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
	echo "Latest release: $$TAG"; \
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
else
	@echo "Skipping llamacpp backend download (macOS only for now)"
endif

# Download llamacpp backend only if not already present (for dev)
download-llamacpp-backend-if-exists:
ifeq ($(shell uname -s),Darwin)
	@if [ -f "src-tauri/resources/llamacpp-backend/build/bin/llama-server" ]; then \
		echo "llamacpp backend already exists, skipping download..."; \
	else \
		$(MAKE) download-llamacpp-backend; \
	fi
else
	@echo "Skipping llamacpp backend (macOS only)"
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
	install -m755 src-tauri/target/debug/jan-cli src-tauri/resources/bin/jan-cli

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
