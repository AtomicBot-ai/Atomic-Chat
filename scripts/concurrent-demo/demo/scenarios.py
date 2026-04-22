"""
demo/scenarios.py — Scenario definitions for the multi-agent demo.

Ported 1-to-1 from the google-gemma/cookbook concurrent demo
(https://github.com/google-gemma/cookbook/tree/main/apps/concurrent) with one
structural change: the HTML page builder lives in demo/templates.py to keep
this module focused on prompts and per-agent card renderers.

Each scenario defines:
  - make_agents(n)    Returns a list of agent dicts.
  - plan              System + user prompts for the orchestrator.
  - system_prompt     System prompt for specialist agents.
  - render_card       Callable(agent, result, task) -> inner HTML.
  - title             Page title.
  - default_n         Default agent count.
"""

from __future__ import annotations

import html
from collections.abc import Callable
from typing import Any

_COLORS: list[str] = [
    "1;35", "1;36", "1;33", "1;32", "1;34", "0;36", "0;35", "0;33", "0;32", "0;34",
    "1;31", "0;31", "1;37", "0;37", "1;35", "1;36", "1;33", "1;32", "1;34", "0;36",
]

_LANG_EMOJIS: list[str] = [
    "🇫🇷", "🇪🇸", "🇩🇪", "🇯🇵", "🇨🇳", "🇰🇷", "🇸🇦", "🇮🇳", "🇧🇷", "🇷🇺",
    "🇮🇹", "🇹🇷", "🇻🇳", "🇹🇭", "🇳🇱", "🇵🇱", "🇸🇪", "🇬🇷", "🇮🇩", "🇺🇦",
]

_LANG_NAMES: list[str] = [
    "french", "spanish", "german", "japanese", "chinese", "korean",
    "arabic", "hindi", "portuguese", "russian", "italian", "turkish",
    "vietnamese", "thai", "dutch", "polish", "swedish", "greek",
    "indonesian", "ukrainian",
]

_SVG_STYLES: list[str] = [
    "minimalist", "cyberpunk", "watercolor", "pixel art",
    "abstract", "geometric", "neon", "vintage",
    "pop art", "isometric", "steampunk", "monochrome",
    "low poly", "surreal", "line art", "flat design",
    "3D render", "anime", "cubism", "synthwave",
]

_CODE_LANGS: list[str] = [
    "python", "javascript", "rust", "go", "c", "java", "ruby", "swift",
    "kotlin", "typescript", "php", "scala", "haskell", "elixir",
    "lua", "perl", "r", "julia", "dart", "zig",
]

_CODE_EMOJIS: list[str] = [
    "🐍", "📜", "🦀", "🐹", "⚙️", "☕", "💎", "🍎",
    "🟣", "🔷", "🐘", "🔴", "λ", "💧",
    "🌙", "🐪", "📊", "🔮", "🎯", "⚡",
]


def make_translate_agents(n: int = 10) -> list[dict[str, Any]]:
    return [
        {
            "name": _LANG_NAMES[i % len(_LANG_NAMES)],
            "emoji": _LANG_EMOJIS[i % len(_LANG_EMOJIS)],
            "color": _COLORS[i % len(_COLORS)],
            "direct_instruction": (
                f"Translate this into {_LANG_NAMES[i % len(_LANG_NAMES)]}: {{topic}}"
            ),
        }
        for i in range(n)
    ]


def make_svg_agents(n: int = 10) -> list[dict[str, Any]]:
    return [
        {
            "name": f"Agent {i + 1}",
            "emoji": "🎨",
            "color": _COLORS[i % len(_COLORS)],
            "direct_instruction": (
                f"Draw a simple SVG of a {{topic}}. "
                f"Use a {_SVG_STYLES[i % len(_SVG_STYLES)]} style. "
                f"Output SVG only and start with <svg"
            ),
        }
        for i in range(n)
    ]


def make_code_agents(n: int = 10) -> list[dict[str, Any]]:
    return [
        {
            "name": _CODE_LANGS[i % len(_CODE_LANGS)],
            "emoji": _CODE_EMOJIS[i % len(_CODE_EMOJIS)],
            "color": _COLORS[i % len(_COLORS)],
            "direct_instruction": (
                f"Write a solution for {{topic}} in "
                f"{_CODE_LANGS[i % len(_CODE_LANGS)]}. Output ONLY code."
            ),
        }
        for i in range(n)
    ]


def make_ascii_agents(n: int = 10) -> list[dict[str, Any]]:
    return [
        {
            "name": f"Agent {i + 1}",
            "emoji": "👾",
            "color": _COLORS[i % len(_COLORS)],
            "direct_instruction": (
                f"Create ASCII art of {{topic}}. Output ASCII art only."
            ),
        }
        for i in range(n)
    ]


TRANSLATE_SYSTEM = (
    "You are a translator. Output ONLY the translated text. "
    "No explanations, no preamble, no original text, no quotes."
)

SVG_SYSTEM = (
    "You are an SVG artist. Output ONLY a raw <svg> tag with viewBox='0 0 120 120'. "
    "Use vibrant colors. No explanations, no markdown, no text before or after the SVG."
)

CODE_SYSTEM = (
    "You are a programmer. Output ONLY the code. "
    "No explanations, no markdown fences, no language labels. Raw code only."
)

ASCII_SYSTEM = (
    "You are an ASCII artist. Output ONLY raw ASCII art. "
    "No explanations, no markdown fences, no text before or after the art."
)


TRANSLATE_PLAN: dict[str, str] = {
    "system": (
        'Output a JSON array with {n_agents} objects. Each has "name" and "instruction". '
        "Keep each instruction to ONE sentence. Output ONLY valid JSON."
    ),
    "user": (
        'Translate this into {n_agents} languages: "{topic}"\n'
        "Agents: {agent_list}\n"
        'Each instruction: "Translate into [language]: [text]". That is all.'
    ),
}

SVG_PLAN: dict[str, str] = {
    "system": (
        'Output a JSON array with {n_agents} objects. Each has "name", "instruction", and "label". '
        'The "label" is a short 2-4 word title for the SVG (e.g. "A Cat"). '
        "Output ONLY valid JSON."
    ),
    "user": (
        'Theme: "{topic}". Agents: {agent_list}\n'
        'Each instruction: "Draw a simple SVG of [specific thing].". '
        "One sentence max. Do NOT mention size or format."
    ),
}

CODE_PLAN: dict[str, str] = {
    "system": (
        'Output a JSON array with {n_agents} objects. Each has "name" and "instruction". '
        "Keep each instruction to ONE sentence. Output ONLY valid JSON."
    ),
    "user": (
        'Task: "{topic}". Agents (each is a programming language): {agent_list}\n'
        'Each instruction: "Write [specific solution] in [language]". One sentence. That is all.'
    ),
}

ASCII_PLAN: dict[str, str] = {
    "system": (
        'Output a JSON array with {n_agents} objects. Each has "name", "instruction", and "label". '
        'The "label" is a one word description of the ASCII art (e.g. "Cat"). '
        "Output ONLY valid JSON."
    ),
    "user": (
        'Theme: "{topic}". Agents (each is an ASCII artist): {agent_list}\n'
        'Each instruction: "Create realistic and small ASCII (max 20x60 characters) art of '
        "[specific aspect of the theme - one word description only]\". "
        "One sentence. That is all. "
    ),
}


def translate_card(agent: dict, result: str, task: dict | None = None) -> str:
    name = agent["name"]
    emoji = agent["emoji"]
    text = result.strip().strip("`").strip()
    return (
        '<div class="flex items-center gap-2 mb-3">\n'
        f'    <span class="text-xl">{emoji}</span>\n'
        f'    <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">'
        f"{name}</span>\n"
        "</div>\n"
        f'<div class="text-sm text-gray-700 leading-relaxed">{text}</div>'
    )


def svg_card(agent: dict, result: str, task: dict | None = None) -> str:
    name = agent["name"]
    label = task.get("label", name.title()) if task else name.title()
    svg = result
    if "<svg" in svg:
        start = svg.index("<svg")
        end = svg.index("</svg>") + 6 if "</svg>" in svg else len(svg)
        svg = svg[start:end]
    else:
        svg = (
            '<div class="text-sm text-gray-400 p-4 text-center">'
            "Failed to generate SVG</div>"
        )
    return (
        f'<div class="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">'
        f"{name}</div>\n"
        f'<div class="w-full aspect-square flex items-center justify-center p-2">{svg}</div>\n'
        f'<div class="text-sm font-semibold text-gray-500 mt-3 pt-3 border-t border-gray-200 '
        f'w-full text-center">{label}</div>'
    )


def code_card(agent: dict, result: str, task: dict | None = None) -> str:
    name = agent["name"]
    emoji = agent.get("emoji", "💻")
    code = result.strip()
    if code.startswith("```"):
        lines = code.split("\n")
        lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        code = "\n".join(lines)
    escaped = html.escape(code)
    lang_class = f"language-{name}" if name in _CODE_LANGS else ""
    return (
        '<div class="flex items-center gap-2 px-1 pb-3 mb-3 border-b border-gray-200">\n'
        f'    <span class="text-lg">{emoji}</span>\n'
        f'    <span class="text-xs font-semibold text-gray-500 uppercase tracking-wider">'
        f"{name}</span>\n"
        "</div>\n"
        f'<pre class="m-0 text-xs leading-relaxed overflow-auto">'
        f'<code class="{lang_class}" style="padding: 0; background: transparent;">'
        f"{escaped}</code></pre>"
    )


def ascii_card(agent: dict, result: str, task: dict | None = None) -> str:
    name = agent["name"]
    label = task.get("label", name.title()) if task else name.title()
    art = result
    if art.startswith("```"):
        lines = art.split("\n")
        lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        art = "\n".join(lines)
    art = art.strip("\n")
    escaped = html.escape(art)
    return (
        f'<div class="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">'
        f"{name}</div>\n"
        f'<div class="w-full bg-gray-900 rounded-lg p-4 flex items-center justify-center '
        'min-h-[180px] overflow-auto">\n'
        f'    <pre class="text-base font-mono text-green-400 leading-tight" '
        f'style="text-shadow: 0 0 5px rgba(74, 222, 128, 0.5);">{escaped}</pre>\n'
        "</div>\n"
        f'<div class="text-sm font-semibold text-gray-500 mt-3 pt-3 border-t border-gray-200 '
        f'w-full text-center">{label}</div>'
    )


CardRenderer = Callable[[dict, str, dict | None], str]

SCENARIOS: dict[str, dict[str, Any]] = {
    "translate": {
        "make_agents": make_translate_agents,
        "plan": TRANSLATE_PLAN,
        "system_prompt": TRANSLATE_SYSTEM,
        "render_card": translate_card,
        "title": "Translation Grid",
        "default_n": 10,
    },
    "svg": {
        "make_agents": make_svg_agents,
        "plan": SVG_PLAN,
        "system_prompt": SVG_SYSTEM,
        "render_card": svg_card,
        "title": "SVG Art Gallery",
        "default_n": 10,
    },
    "code": {
        "make_agents": make_code_agents,
        "plan": CODE_PLAN,
        "system_prompt": CODE_SYSTEM,
        "render_card": code_card,
        "title": "Code Gallery",
        "extra_head": (
            '    <link rel="stylesheet" '
            'href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css">\n'
            '    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>'
        ),
        "extra_body": "    <script>hljs.highlightAll();</script>",
        "default_n": 10,
    },
    "ascii": {
        "make_agents": make_ascii_agents,
        "plan": ASCII_PLAN,
        "system_prompt": ASCII_SYSTEM,
        "render_card": ascii_card,
        "title": "ASCII Art Gallery",
        "default_n": 10,
    },
}


def get_scenario(name: str, n_agents: int | None = None) -> dict[str, Any]:
    """Materialise a scenario with concrete agents and prompts.

    `n_agents` overrides the scenario's default_n. All `{n_agents}` placeholders
    in the orchestrator prompts are resolved here so downstream callers can
    treat `scenario["plan"]` as plain strings.
    """
    if name not in SCENARIOS:
        available = ", ".join(SCENARIOS.keys())
        raise KeyError(f"Unknown scenario '{name}'. Available: {available}")
    scenario = dict(SCENARIOS[name])
    n = n_agents or scenario["default_n"]
    scenario["agents"] = scenario["make_agents"](n)
    scenario["plan"] = {
        k: v.replace("{n_agents}", str(n)) if isinstance(v, str) else v
        for k, v in scenario["plan"].items()
    }
    return scenario
