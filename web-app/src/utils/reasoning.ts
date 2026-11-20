import {
  ChatCompletionMessage,
  chatCompletionRequestMessage,
} from '@janhq/core'

// Helper function to get reasoning content from an object
function getReasoning(
  obj:
    | { reasoning_content?: string | null; reasoning?: string | null }
    | null
    | undefined
): string | null {
  return obj?.reasoning_content ?? obj?.reasoning ?? null
}

/**
 * Normalize the content of a message by removing reasoning content.
 * This is useful to ensure that reasoning content does not get sent to the model.
 * @param content
 * @returns
 */
export function removeReasoningContent(content: string): string {
  // Reasoning content should not be sent to the model.
  let result = content

  // Strip every complete <think>…</think> block. A model can emit several
  // reasoning spans across one turn, so this has to be global — the previous
  // code only ever removed the first block.
  result = result.replace(/<think>([\s\S]*?)<\/think>/g, '')

  // Strip an unterminated <think>… block (streaming cut off before the
  // closing tag) so partial reasoning still doesn't leak into the prompt.
  result = result.replace(/<think>[\s\S]*$/, '')

  // Same treatment for the DeepSeek <|channel|>analysis<|message|>…
  // reasoning format.
  result = result.replace(
    /<\|channel\|>analysis<\|message\|>([\s\S]*?)<\|start\|>assistant<\|channel\|>final<\|message\|>/g,
    ''
  )
  result = result.replace(/<\|channel\|>analysis<\|message\|>[\s\S]*$/, '')

  return result.trim()
}

// Extract reasoning from a message (for completed responses)
export function extractReasoningFromMessage(
  message: chatCompletionRequestMessage | ChatCompletionMessage
): string | null {
  if (!message) return null

  const extendedMessage = message as chatCompletionRequestMessage
  return getReasoning(extendedMessage)
}