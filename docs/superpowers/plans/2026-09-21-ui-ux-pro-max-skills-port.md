# Porting the UI UX Pro Max skills into Radium's bundled skills

**Status: in progress. Not safe to merge.** This branch keeps the import work
so it is not lost. It must stay a draft until every blocker below is closed.
It continues PR #39, which was closed because the skills could not ship safely
by default.

## Goal

Ship the seven UI UX Pro Max design skills with Radium, so a new install has
them without uploading anything. They are copied into the user's skills folder
at start-up and, like every bundled skill, stay switched off until the user
reviews and allows each one.

## Source and licence

- **Plugin:** [`nextlevelbuilder/ui-ux-pro-max-skill`](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) v2.13.0.
- **Licence:** MIT, copyright 2024 Next Level Builder, so bundling is allowed as long as the notice ships with the files. `LICENSE` sits beside every skill.
- **`ui-styling` fonts:** its bundled fonts carry their own licences. `LICENSE.txt` is Apache-2.0, plus one `*-OFL.txt` per font family, except Instrument Serif (see blockers).

## What is done

| Skill | Files | Scripts |
|---|---|---|
| `ui-ux-pro-max` | 73 | yes |
| `ui-styling` | 99 | yes |
| `design` | 36 | yes |
| `design-system` | 27 | yes |
| `brand` | 18 | yes |
| `slides` | 6 | no |
| `banner-design` | 2 | no |

About 11 MB in total, against 121 KB for the 18 skills bundled before.

1. **Files copied.** All seven skills are in `src-tauri/resources/agent-skills/<name>/`. Bodies, references, scripts and data are unchanged from upstream.
2. **Headers rewritten.** Upstream uses Claude Code's frontmatter keys (`argument-hint`, `license`, `metadata`), which Radium's parser rejects (`deny_unknown_fields`). Each `SKILL.md` header now uses Radium's keys:
   - `name`, `description`, `version`;
   - `requires_tools`, `dangerous: false`;
   - `platforms: [darwin, linux, win32]`.

   An HTML comment under each header records the source and that only the header changed.
3. **One description shortened.** Radium allows 512 characters and `design`'s was 637.
4. **Platform policy.** All seven are registered in `bundled_skills_follow_explicit_platform_metadata_policy` (`src-tauri/src/core/agent/skills/seeding.rs`).
5. **Tests.** `cargo test --lib agent::skills` passed on 2026-09-19.

## Blockers (verified against the code on 2026-09-21)

The first four each make the port unsafe or broken by themselves.

1. **Seeding deletes a user's own skill with the same name.**
   - `seed_starter_skills` calls `remove_dir_all(&destination)` before installing each bundled skill (`seeding.rs`).
   - `design`, `brand`, `slides`, `design-system`, `ui-styling` and `banner-design` are ordinary names a user may already have used, so updating Radium would silently delete that user's skill.
   - **Fix:** give the bundled skills names that cannot collide (for example a `uupm-` prefix, updating cross-references between the skills), or make seeding skip a folder it did not create.
2. **The main skill's search cannot run in Radium.**
   - `ui-ux-pro-max/SKILL.md` finds its search script through `CLAUDE_PLUGIN_ROOT` (11 references), a Claude Code variable Radium never sets.
   - The manifest declares no `requires_scripts`, so `skill.run_script` cannot reach the script either.
   - Across the seven skills there are 16 Claude-only references, including instructions to call `AskUserQuestion`, a tool Radium does not have. Radium asks questions through its normal reply.
   - **Fix:** declare the scripts in `requires_scripts` and rewrite the invocations for Radium's skill runtime; replace `AskUserQuestion` with asking in the reply.
3. **The main skill is cut off when loaded.**
   - `LOADED_SKILL_BODY_MAX_CHARS` is 16,000, but `ui-ux-pro-max/SKILL.md` is 16,568 characters before Radium prepends its runtime contract.
   - The troubleshooting table and the pre-delivery checklist at the end never reach the model.
   - **Fix:** move late material into a reference file the skill tells the model to read early.
4. **The approval screen can hide executable code.**
   - The review preview shows at most `PREVIEW_MAX_FILES` = 50 files (`skills/commands.rs`), and `ui-styling` has 99.
   - The fonts sort first, so its scripts never appear, and warning scanning runs over the same truncated list. A user would approve code the screen never showed.
   - **Fix:** preview executable files first and page through the rest. This is a Radium change that protects any large skill, not just these.
5. **Missing font licence.** `InstrumentSerif-Regular.ttf` and `InstrumentSerif-Italic.ttf` are SIL OFL 1.1 fonts, but only `InstrumentSans-OFL.txt` is present. Add `InstrumentSerif-OFL.txt` from the font's source before shipping, or drop the two fonts.
6. **Permissions are understated.**
   - The rewritten headers declare only `os.fs.read`, plus `os.shell.run` where there are scripts.
   - Several skills write files (for example `banner-design` writes into `assets/banners/`), so the review screen understates what they do.
   - **Fix:** declare the write tools each skill actually uses.

## Also found by review (upstream bugs, lower priority)

- `design-system/scripts/generate-slide.py` resolves output paths assuming the `.claude/skills/` layout, so decks land outside the user's project. Its `--demo` deck is branded "ClaudeKit".
- `brand/scripts/sync-brand-to-tokens.cjs` overwrites the brand name with `ClaudeKit Marketing - Primary`.
- `brand/scripts/extract-colors.cjs` prints instructions instead of extracting colours. `validate-asset.cjs` never checks image dimensions.
- `design/scripts/logo/generate.py` and the icon and CIP generators exit 0 when generation fails.
- `design/scripts/icon/generate.py` saves model-generated SVG without sanitising it: scripts, event handlers and external references are not stripped.
- `ui-styling/scripts/tailwind_config_gen.py` overwrites an existing Tailwind config without asking. `shadcn_add.py` resolves `@/` aliases without the project's path map.

These are bugs in upstream code. Fix them here, report them upstream, or leave out the scripts that have them.

## Also decide

- **Mobile builds.** Both mobile Tauri configs bundle `resources/agent-skills/**/*`, so the phone apps would carry about 9.5 MB of skills they cannot enable. Filter bundling or seeding by platform.
- **Installer size.** Most of the 11 MB is `ui-styling`'s fonts (about 5.6 MB) and `ui-ux-pro-max`'s icon and font data. Dropping the fonts loses only `ui-styling`'s canvas rendering.
- **Python.** `ui-ux-pro-max` searches with a Python script. Without Python the written guidance still works, but search does not. Decide whether that is acceptable or whether Radium should say so.

## DevSkim alerts

DevSkim raised 15 alerts on #39. Each was checked against its line, and none is a secret:

- **"Tokens or keys":** SHA-256 checksums of the skill's own data files, content fingerprints, and a Google Fonts commit id.
- **"Insecure URL":** the string `http://` inside a URL allow-list that rejects `javascript:` URIs, and a URL in a mocked test response.
- **"Debug code":** code that *rejects* `localhost`, `.local` and `.internal` hostnames (SSRF protection), and its test.

They need dismissing as false positives, or an ignore path for these files in `.github/workflows/devskim.yml`.

## Until then

Anyone who wants these skills now can add them by hand: Plugins → Skills → Upload skill, one `.zip` per skill. Skills added that way do not replace anything on start-up, so blocker 1 does not apply.
