# Security Policy

## Supported versions

The following Radium releases receive security fixes:

| Version | Supported          |
| ------- | ------------------ |
| 0.6.x   | :white_check_mark: |
| < 0.6   | :x:                |

Only the latest stable release is patched for security issues. Older releases are not supported.

## Reporting a vulnerability

**Please do not report security issues through public GitHub issues.**

To report a security vulnerability, use GitHub's **Private Vulnerability Reporting**:

1. Go to **Security** → **Advisories** → **Report a vulnerability** on the [Radium repository](https://github.com/walladanger/Radium).
2. Describe the vulnerability, the affected component, and include a proof of concept or reproduction steps where possible.
3. Submit the report. It is delivered privately to the maintainers and is not visible to the public.

If Private Vulnerability Reporting is unavailable, open a private message to the repository owner via their [GitHub profile](https://github.com/walladanger).

## Response expectations

- **Acknowledgment:** We acknowledge receipt of a valid report within **7 days**.
- **Triage:** We assess severity and scope within **14 days** of acknowledgment.
- **Fix:** We aim to ship a fix for confirmed, high- or critical-severity issues within **30 days** of acknowledgment.
- **Disclosure:** We coordinate a public disclosure date with the reporter before publishing an advisory.

## Scope

In scope: the Radium desktop application (Rust backend in `src-tauri/`, TypeScript in `core/` and `web-app/`, extensions in `extensions/`), the bundled OpenAI-compatible server, and the CI/CD workflows in `.github/workflows/`.

Out of scope: third-party model weights, user-supplied content, and vulnerabilities in upstream dependencies that are already reported to the upstream project.

## Security features

- Dependabot monitors `npm`, `cargo`, `pip`, and `github-actions` ecosystems (see [`.github/dependabot.yml`](.github/dependabot.yml)).
- Code scanning runs CodeQL, DevSkim, and Super-Linter on every pull request.
- All workflows run with least-privilege `permissions` and pinned action revisions.
