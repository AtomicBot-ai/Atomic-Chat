import { describe, expect, it } from 'vitest'

import {
  CANONICAL_LLAMA3_CHAT_TEMPLATE,
  STRICT_SYSTEM_GUARD_SIGNATURE,
  resolveLlama3TemplateOverride,
} from './chatTemplateOverrides'

describe('resolveLlama3TemplateOverride', () => {
  const guarded = `{{ raise_exception('${STRICT_SYSTEM_GUARD_SIGNATURE}') }}`

  it.each([undefined, null, ''])(
    'leaves a missing embedded template untouched',
    (template) => {
      expect(resolveLlama3TemplateOverride('llama-3.2-3b', template)).toBeNull()
    }
  )

  it('overrides a guarded template identified by model id', () => {
    expect(
      resolveLlama3TemplateOverride('unsloth/Llama-3_2-3B-Instruct', guarded)
    ).toBe(CANONICAL_LLAMA3_CHAT_TEMPLATE)
  })

  it('overrides a guarded template identified by its format marker', () => {
    expect(
      resolveLlama3TemplateOverride(
        'renamed-model',
        `${guarded}<|start_header_id|>`
      )
    ).toBe(CANONICAL_LLAMA3_CHAT_TEMPLATE)
  })

  it('does not override an unguarded Llama 3 template', () => {
    expect(
      resolveLlama3TemplateOverride(
        'llama-3.1-8b',
        '{{ messages }}<|start_header_id|>'
      )
    ).toBeNull()
  })

  it('does not override a guarded non-Llama template', () => {
    expect(resolveLlama3TemplateOverride('qwen-3-8b', guarded)).toBeNull()
  })

  it('returns a canonical template without the strict guard', () => {
    const result = resolveLlama3TemplateOverride('llama.3.3-70b', guarded)

    expect(result).toContain('<|start_header_id|>')
    expect(result).not.toContain(STRICT_SYSTEM_GUARD_SIGNATURE)
  })
})
