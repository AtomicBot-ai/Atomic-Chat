import { describe, expect, it } from 'vitest'
import {
  createEngineErrorFetch,
  openAIErrorBody,
  managedRequestBody,
} from '../request'

/** What the local streaming fetch hands over for a llama.cpp-configured model (finding F-8). */
const LLAMA_CPP_KNOBS = {
  repeat_penalty: 1.1,
  repeat_last_n: 64,
  n_predict: -1,
  cache_prompt: true,
  ctx_len: 8192,
  typical_p: 1,
  mirostat: 0,
  n_probs: 0,
  dry_multiplier: 0,
  reasoning_format: 'deepseek',
  timings_per_token: true,
  parallel_tool_calls: false,
}

const SAMPLING = {
  temperature: 0.7,
  top_p: 0.9,
  top_k: 40,
  min_p: 0.05,
  max_tokens: 512,
  stop: ['</s>'],
  seed: 7,
  frequency_penalty: 0,
  presence_penalty: 0,
  chat_template_kwargs: { enable_thinking: false },
}

const REQUEST = {
  model: 'Qwen/Qwen3-1.7B',
  messages: [{ role: 'user', content: 'hi' }],
  stream: true,
  stream_options: { include_usage: true },
}

const TOOLS = [{ type: 'function', function: { name: 'f', parameters: {} } }]

describe('managedRequestBody', () => {
  it('drops every llama.cpp knob and keeps the request and the sampling fields', () => {
    const shaped = managedRequestBody(
      { ...REQUEST, ...SAMPLING, ...LLAMA_CPP_KNOBS },
      { structuredOutput: false }
    )

    expect(shaped).toEqual({ ...REQUEST, ...SAMPLING })
    for (const key of Object.keys(LLAMA_CPP_KNOBS)) {
      expect(shaped).not.toHaveProperty(key)
    }
  })

  it('keeps max_completion_tokens as the client sent it', () => {
    expect(
      managedRequestBody(
        { ...REQUEST, max_completion_tokens: 256 },
        { structuredOutput: false }
      )
    ).toEqual({ ...REQUEST, max_completion_tokens: 256 })
  })

  it('sends tool_choice only together with tools', () => {
    expect(
      managedRequestBody(
        { ...REQUEST, tools: TOOLS, tool_choice: 'auto' },
        { structuredOutput: false }
      )
    ).toEqual({ ...REQUEST, tools: TOOLS, tool_choice: 'auto' })
    expect(
      managedRequestBody({ ...REQUEST, tool_choice: 'auto' }, { structuredOutput: false })
    ).toEqual(REQUEST)
    expect(
      managedRequestBody(
        { ...REQUEST, tools: [], tool_choice: 'none' },
        { structuredOutput: false }
      )
    ).toEqual(REQUEST)
  })

  it('sends a structured response_format only for a family with structured output', () => {
    const format = { type: 'json_schema', json_schema: { name: 'x', schema: {} } }

    expect(
      managedRequestBody({ ...REQUEST, response_format: format }, { structuredOutput: true })
    ).toEqual({ ...REQUEST, response_format: format })
    expect(
      managedRequestBody({ ...REQUEST, response_format: format }, { structuredOutput: false })
    ).toEqual(REQUEST)
    expect(
      managedRequestBody(
        { ...REQUEST, response_format: { type: 'text' } },
        { structuredOutput: true }
      )
    ).toEqual(REQUEST)
  })
})

describe('openAIErrorBody', () => {
  it("lifts trtllm-serve's flat message into OpenAI's error envelope", () => {
    const engine = JSON.stringify({
      object: 'error',
      message: "1 validation error for ChatCompletionRequest\nrepeat_penalty\n  Extra inputs are not permitted [type=extra_forbidden]",
      type: 'BadRequestError',
      param: null,
      code: 400,
    })

    expect(JSON.parse(openAIErrorBody(engine)!)).toEqual({
      error: {
        message: expect.stringContaining('extra_forbidden'),
        type: 'BadRequestError',
        code: 400,
      },
    })
  })

  it('reads FastAPI detail and a bare error string too', () => {
    expect(JSON.parse(openAIErrorBody('{"detail":"Not Found"}')!).error.message).toBe('Not Found')
    expect(JSON.parse(openAIErrorBody('{"error":"bad"}')!).error.message).toBe('bad')
  })

  it('leaves an OpenAI-shaped body, a body without a message and non-JSON alone', () => {
    expect(openAIErrorBody('{"error":{"message":"x"}}')).toBeNull()
    expect(openAIErrorBody('{"code":400}')).toBeNull()
    expect(openAIErrorBody('Bad Request')).toBeNull()
  })
})

describe('createEngineErrorFetch', () => {
  it("rewrites an engine's 4xx body and passes a success through untouched", async () => {
    const ok = new Response('data: x\n\n', { status: 200 })
    const refused = new Response('{"object":"error","message":"nope","code":400}', {
      status: 400,
    })
    const inner = async (input: string) => (input === 'ok' ? ok : refused)
    const fetch = createEngineErrorFetch(inner)

    expect(await fetch('ok')).toBe(ok)
    const response = await fetch('refused')
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: { message: 'nope', type: null, code: 400 },
    })
  })
})
