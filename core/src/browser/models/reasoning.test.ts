import { describe, it, expect } from 'vitest'
import { detectReasoningControls } from './reasoning'

/**
 * Fixtures are excerpts of the reference chat templates shipped in llama.cpp
 * (`models/templates/`), kept verbatim so the detector is exercised against the
 * exact Jinja the backends see.
 */

// tencent-Hy3.jinja — validates its input and raises on anything else.
const HY3 = `
{%- if not reasoning_effort is defined %}
    {%- set reasoning_effort = 'no_think' %}
{%- elif reasoning_effort not in ['high', 'low', 'no_think'] %}
    {{- raise_exception('reasoning_effort error : ' + reasoning_effort + ', should be no_think/low/high') }}
{%- endif %}
{%- if reasoning_effort is defined and reasoning_effort in ['low', 'high'] %}
    {{- assistant_token + think_begin_token }}
{%- endif %}
`

// Inkling.jinja — enumerates the legal values in its error message.
const INKLING = `
{%- macro reasoning_effort_text(effort) -%}
  {%- if eff is string -%}
    {%- if e == 'minimal' -%}{%- set eff = 0.1 -%}
    {%- endif -%}
  {%- endif -%}
  {%- if value < 0 or value > 0.99 -%}
    {{- raise_exception('Invalid reasoning_effort: ' + (effort | string) + '; expected none/minimal/low/medium/high/xhigh/max or a number in [0.0, 0.99]') -}}
  {%- endif -%}
{%- endmacro -%}
`

// openai-gpt-oss-120b.jinja — free-form string, no validation.
const GPT_OSS = `
{%- if reasoning_effort is not defined %}
    {%- set reasoning_effort = "medium" %}
{%- endif %}
{{- "Reasoning: " + reasoning_effort + "\\n\\n" }}
`

// upstage-Solar-Open-100B.jinja — special-cases a subset, so the "in [...]"
// list is not the legal value set.
const SOLAR = `
{%- set reasoning_effort = reasoning_effort if reasoning_effort is defined else "high" %}
{%- if add_generation_prompt -%}
    {%- if reasoning_effort in ["low", "minimal"] -%}
        {{- "<|begin|>assistant<|think|><|end|>" }}
    {%- endif -%}
{%- endif -%}
`

// Qwen-Qwen3-0.6B.jinja — on/off only.
const QWEN3 = `
{%- if add_generation_prompt %}
    {{- '<|im_start|>assistant\\n' }}
    {%- if enable_thinking is defined and enable_thinking is false %}
        {{- '<think>\\n\\n</think>\\n\\n' }}
    {%- endif %}
{%- endif %}
`

// ByteDance-Seed-OSS.jinja — token budget rendered into the prompt.
const SEED_OSS = `
{%- if not thinking_budget is defined %}
{%- set thinking_budget = -1 -%}
{%- endif %}
{%- if thinking_budget == 0 %}
{{ "You are an intelligent assistant that can answer questions in one step without the need for reasoning and thinking" }}
{%- endif %}
`

// meta-llama-3 style — no thinking at all.
const NON_THINKING = `
{%- for message in messages %}
    {{- '<|start_header_id|>' + message['role'] + '<|end_header_id|>\\n\\n' + message['content'] | trim + '<|eot_id|>' }}
{%- endfor %}
{%- if add_generation_prompt %}
    {{- '<|start_header_id|>assistant<|end_header_id|>\\n\\n' }}
{%- endif %}
`

describe('detectReasoningControls', () => {
  it('reports no thinking support for a missing or empty template', () => {
    expect(detectReasoningControls()).toEqual({ supportsThinking: false })
    expect(detectReasoningControls('')).toEqual({ supportsThinking: false })
  })

  it('reports no thinking support for a plain instruct template', () => {
    expect(detectReasoningControls(NON_THINKING)).toEqual({
      supportsThinking: false,
    })
  })

  it('takes the legal value set from a validation guard', () => {
    const controls = detectReasoningControls(HY3)

    expect(controls.supportsThinking).toBe(true)
    expect(controls.effortKwarg).toBe('reasoning_effort')
    expect(controls.effortValues).toEqual(['low', 'high'])
    expect(controls.offValue).toBe('no_think')
  })

  it('takes the legal value set from an enumerated error message', () => {
    const controls = detectReasoningControls(INKLING)

    expect(controls.effortKwarg).toBe('reasoning_effort')
    expect(controls.effortValues).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    expect(controls.offValue).toBe('none')
  })

  it('falls back to the canonical levels when the template does not validate', () => {
    const controls = detectReasoningControls(GPT_OSS)

    expect(controls.effortKwarg).toBe('reasoning_effort')
    expect(controls.effortValues).toEqual(['low', 'medium', 'high'])
    expect(controls.offValue).toBeUndefined()
  })

  it('ignores a positive "in [...]" check, which only special-cases a subset', () => {
    const controls = detectReasoningControls(SOLAR)

    expect(controls.effortKwarg).toBe('reasoning_effort')
    expect(controls.effortValues).toEqual(['low', 'medium', 'high'])
  })

  it('detects an on/off-only thinking model without an effort knob', () => {
    expect(detectReasoningControls(QWEN3)).toEqual({ supportsThinking: true })
  })

  it('detects a template-native thinking budget', () => {
    expect(detectReasoningControls(SEED_OSS)).toEqual({
      supportsThinking: true,
      effortKwarg: 'thinking_budget',
    })
  })

  it('detects thinking from paired tags alone', () => {
    expect(
      detectReasoningControls('{{ "<think>" }} ... {{ "</think>" }}')
    ).toEqual({ supportsThinking: true })
    expect(
      detectReasoningControls('{{ "<|START_THINKING|><|END_THINKING|>" }}')
    ).toEqual({ supportsThinking: true })
  })
})
