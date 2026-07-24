---
name: skill-creator
description: Author or edit Atomic Chat Agent skills (SKILL.md + YAML). Use when creating, renaming, or tightening skills and their install layout.
version: 1.3.1
requires_tools:
  - os.fs.read
  - os.fs.write
  - os.fs.list
dangerous: false
platforms:
  - darwin
  - linux
  - win32
---

# skill-creator

## Critical — invalid files are skipped at load

`SKILL.md` **must** start with the bytes `---` then a newline, YAML mapping, closing `---` line, then markdown body.

If the file starts with `# Title` or prose **without** that frontmatter block, the runtime **drops** the skill (parse error); it will not appear in `### skills`.

## Minimal valid template (copy and edit)

```markdown
---
name: my-skill-name
description: One line when to load this skill and what it does (English ok).
version: 1.0.0
requires_tools: []
requires_scripts: []
dangerous: false
platforms:
  - darwin
  - linux
  - win32
---

# my-skill-name

Body here. Use real Atomic Chat Agent tool names such as `skill.view`,
`os.http.request`, and `os.web.search`.
```

Rules:

- `name` — kebab-case, **same string as the parent folder** (`my-skill-name/SKILL.md` → `name: my-skill-name`).
- `description` and `version` — required non-empty strings.
- `requires_tools` — tools used by the skill body, such as `os.shell.run`.
- `requires_scripts` — exact bundled filenames located under
  `<skill>/scripts/`; `skill.run_script.script` may contain only one of these
  filenames. External commands such as `memo`, `gh`, or `docker` are not
  scripts: invoke them through `os.shell.run` with separate `cmd` and `args`.
  Omit empty keys if you prefer.

## Where to write files

| Scope | Path |
|-------|------|
| Global | `<Atomic Chat data folder>/agent-skills/<name>/SKILL.md` |

Atomic Chat currently loads only this global root. One folder per skill;
single `SKILL.md` at folder root.

## Workflow

1. Create folder + `SKILL.md` using the template above (frontmatter first).
2. Keep `description` short; put procedures in the body (visible only after `skill.view`).
3. Open Agent → Skills and refresh so the registry rescans disk.
4. Verify that the skill appears in the Skills list without an error.

## Do not

- Skip YAML — **ever**.
- Put secrets in the file or instruct bypassing approvals / HTTP allowlists.
