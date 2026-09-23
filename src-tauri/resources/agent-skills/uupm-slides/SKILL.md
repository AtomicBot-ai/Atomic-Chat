---
name: uupm-slides
description: Create strategic HTML presentations with Chart.js, design tokens, responsive layouts, copywriting formulas, and contextual slide strategies.
version: 1.0.0
requires_tools:
  - os.fs.read
  - os.fs.write
  - os.fs.mkdir
dangerous: false
platforms:
  - darwin
  - linux
  - win32
---
<!-- Bundled with Radium from the MIT-licensed UI UX Pro Max plugin
     (nextlevelbuilder/ui-ux-pro-max-skill, v2.13.0). Its licence is in
     LICENSE beside this file; the frontmatter was rewritten (to
     Radium's own keys), the skill was renamed with a uupm- prefix
     so it cannot replace a skill of the user's own, and script invocations
     were pointed at Radium's skill.run_script. -->

## Running things in Radium

This skill has no bundled scripts. Use the tools it declares. Ask the user
questions in your reply: Radium has no `AskUserQuestion` tool.

# Slides

Strategic HTML presentation design with data visualization.

## When to Use

- Marketing presentations and pitch decks
- Data-driven slides with Chart.js
- Strategic slide design with layout patterns
- Copywriting-optimized presentation content

## Subcommands

| Subcommand | Description | Reference |
|------------|-------------|-----------|
| `create` | Create strategic presentation slides | `references/create.md` |

## Script Paths

Script paths in this skill and its `references/` are relative to the directory that contains this SKILL.md, not to the project: `scripts/<file>` is this skill's own `scripts/` folder, and `../<skill>/scripts/<file>` is a sibling sub-skill installed alongside it. Build the full path from that directory (Claude Code reports it as the skill's base directory when the skill loads) and keep the working directory at the project root — the scripts read and write project files such as `docs/brand-guidelines.md`, `assets/design-tokens.json` or `src/` relative to it.

## References (Knowledge Base)

| Topic | File |
|-------|------|
| Layout Patterns | `references/layout-patterns.md` |
| HTML Template | `references/html-template.md` |
| Copywriting Formulas | `references/copywriting-formulas.md` |
| Slide Strategies | `references/slide-strategies.md` |

## Routing

1. Parse subcommand from `$ARGUMENTS` (first word)
2. Load corresponding `references/{subcommand}.md`
3. Execute with remaining arguments
