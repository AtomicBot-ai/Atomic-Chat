# Подпись Atomic Chat (Jan / Tauri) для macOS

По [официальной схеме Tauri](https://v2.tauri.app/distribute/sign/macos/): переменные окружения + `yarn build`. Ручной `codesign` по всему `.app` не нужен — его выполняет CLI Tauri при сборке.

## Что нужно

1. **Apple Developer Program** ($99/год): [developer.apple.com](https://developer.apple.com/programs/).
2. В связке ключей — **Developer ID Application** (не «Apple Distribution» для Mac App Store).

Сертификат создаётся только у Apple: CSR на Mac → загрузка в [Certificates](https://developer.apple.com/account/resources/certificates/list) → скачать `.cer` → открыть (ключ попадёт в «Связку ключей»). **Сгенерировать сертификат за вас из репозитория нельзя** — нужна ваша учётка разработчика.

---

## Шаг 1: Узнать signing identity

```bash
security find-identity -v -p codesigning
```

Строка вида `Developer ID Application: … (TEAMID)` — это **полное имя**. При нескольких совпадениях надёжнее указать **SHA-1** из первого столбца.

---

## Шаг 2: Сборка с подписью (как в проекте)

Из корня репозитория `jan/`:

```bash
# при необходимости положить расширения в pre-install (копирует в bundle)
cp src-tauri/resources/pre-install/*.tgz pre-install/ 2>/dev/null || true

export APPLE_SIGNING_IDENTITY="Developer ID Application: SpaceshipIntelligence OU (UT6WGPGTGR)"
# или: export APPLE_SIGNING_IDENTITY="XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"

CI=false yarn build
```

`CI=false` обязателен: иначе Tauri в режиме CI может **не** подписывать.

Готовый **universal** DMG (Intel + Apple Silicon):

`src-tauri/target/universal-apple-darwin/release/bundle/dmg/Atomic Chat_*.dmg`

(имя берётся из `productName` в `tauri.conf.json`.)

Проверка подписи приложения:

```bash
codesign -dv --verbose=2 "src-tauri/target/universal-apple-darwin/release/bundle/macos/Atomic Chat.app" 2>&1 | grep -E "Authority|Timestamp|runtime"
```

Должны быть цепочка **Developer ID** → **Developer ID Certification Authority** → **Apple Root CA**, **Timestamp**, у основного бинарника — **flags** с runtime (Hardened Runtime задаёт Tauri при подписи).

Перед фазой bundle запускается `src-tauri/scripts/strip-macos-xattrs.sh` (снятие `xattr`), иначе `codesign` иногда падает с `resource fork, Finder information, or similar detritus not allowed`.

Tauri подписывает только `Contents/MacOS/*`. Копии CLI из `bundle.resources` попадают в `Contents/Resources/resources/bin/` **без** повторной подписи, из‑за чего notarytool отклоняет архив. Скрипт `src-tauri/scripts/sign-macos-resource-binaries.sh` (в цепочке `beforeBundleCommand`) подписывает `jan-cli`, `mlx-server`, `foundation-models-server` в `resources/bin/` до копирования в bundle — при заданном `APPLE_SIGNING_IDENTITY`.

---

## Опционально: нотаризация

Без нотаризации пользователи, скачавшие DMG из Telegram/браузера, увидят **«Apple could not verify … free of malware»** (карантин + Gatekeeper).

Готовый сценарий из корня `jan/` (проверяет переменные и вызывает `yarn build`):

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: …"
export APPLE_ID="your@email.com"
export APPLE_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="UT6WGPGTGR"
yarn build:macos:notarized
```

Скрипт: `scripts/macos-build-signed-notarized.sh`. Альтернатива — ключи API: `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_PATH` (см. [Tauri — Notarization](https://v2.tauri.app/distribute/sign/macos/)).

---

Нужны учётные данные для Apple:

- **APPLE_ID** — email Apple ID разработчика.
- **APPLE_PASSWORD** — [пароль для приложений](https://appleid.apple.com/account/manage) (не обычный пароль Apple ID).
- **APPLE_TEAM_ID** — Team ID (10 символов, виден в сертификате и на developer.apple.com).

```bash
export APPLE_SIGNING_IDENTITY="…"
export APPLE_ID="your@email.com"
export APPLE_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="UT6WGPGTGR"
CI=false yarn build
```

Tauri отправит билд на нотаризацию после сборки (см. доку Tauri). Либо после сборки вручную: `xcrun notarytool submit … --wait` и `xcrun stapler staple` для DMG — см. [notarytool](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution).

---

## Нативная сборка только под текущий Mac (быстрее, не universal)

Для локальных тестов без Intel-слоя:

```bash
CI=false APPLE_SIGNING_IDENTITY="…" yarn build:web && yarn build:icon && yarn copy:assets:tauri && CI=false APPLE_SIGNING_IDENTITY="…" yarn build:tauri:darwin:native
```

DMG: `src-tauri/target/release/bundle/dmg/Atomic Chat_*_aarch64.dmg` (на Apple Silicon).

---

## Если нет Apple Developer

Распространять подписанный билд «для всех» нельзя. Локально можно открыть неподписанное приложение: правый клик → **Открыть**, или:

```bash
xattr -cr "/Applications/Atomic Chat.app"
```
