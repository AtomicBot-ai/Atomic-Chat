import { useCallback, useState, useRef, useEffect, useMemo } from 'react'
import { ThreadMessage, ContentType } from '@janhq/core'
import { useServiceHub } from './useServiceHub'
import { useModelProvider } from './useModelProvider'
import { usePrompt } from './usePrompt'
import { removeReasoningContent } from '@/utils/reasoning'

export interface TokenCountData {
  tokenCount: number
  maxTokens?: number
  percentage?: number
  isNearLimit: boolean
  loading: boolean
  error?: string
}

type InlineFileContent = {
  name?: string
  content: string
}

const getInlineFileContents = (
  metadata: ThreadMessage['metadata']
): InlineFileContent[] => {
  const inlineFileContents = (
    metadata as { inline_file_contents?: unknown }
  )?.inline_file_contents

  if (!Array.isArray(inlineFileContents)) return []

  return inlineFileContents.filter((file): file is InlineFileContent => {
    if (!file || typeof file !== 'object') return false
    const { content, name } = file as { content?: unknown; name?: unknown }

    const hasContent = typeof content === 'string' && content.length > 0
    const hasValidName =
      typeof name === 'string' || typeof name === 'undefined'

    return hasContent && hasValidName
  })
}

export const useTokensCount = (
  messages: ThreadMessage[] = [],
  uploadedFiles?: Array<{
    name: string
    type: string
    size: number
    base64: string
    dataUrl: string
  }>
) => {
  const [tokenData, setTokenData] = useState<TokenCountData>({
    tokenCount: 0,
    loading: false,
    isNearLimit: false,
  })

  const debounceTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined)
  const latestCalculationRef = useRef<(() => Promise<void>) | null>(null)
  const inFlightRef = useRef(false)
  const needsRecalcRef = useRef(false)
  const isIncreasingContextSize = useRef<boolean>(false)
  const serviceHub = useServiceHub()
  const { selectedModel, selectedProvider } = useModelProvider()
  const { prompt } = usePrompt()

  // Create messages with current prompt for live calculation.
  // This mirrors the payload sent to token counting by appending the draft
  // user message (text plus any uploaded images) to the existing thread
  // history so the model sees the full context that will be submitted.
  const messagesWithPrompt = useMemo(() => {
    const result = [...messages]
    if (prompt.trim() || (uploadedFiles && uploadedFiles.length > 0)) {
      const content = []

      // Add text content if prompt exists
      if (prompt.trim()) {
        content.push({ type: ContentType.Text, text: { value: prompt } })
      }

      // Add image content for uploaded files
      if (uploadedFiles && uploadedFiles.length > 0) {
        uploadedFiles.forEach((file) => {
          content.push({
            type: ContentType.Image,
            image_url: {
              url: file.dataUrl,
              detail: 'high', // Default to high detail for token calculation
            },
          })
        })
      }

      if (content.length > 0) {
        result.push({
          id: 'temp-prompt',
          thread_id: '',
          role: 'user',
          content,
          created_at: Date.now(),
        } as ThreadMessage)
      }
    }
    return result.map((e) => {
      // Pull inline file contents stored on the message metadata
      const inlineFileContents = getInlineFileContents(e.metadata)

      const buildInlineText = (base: string) => {
        if (!inlineFileContents.length) return base
        const formatted = inlineFileContents
          .map((f) => `File: ${f.name || 'attachment'}\n${f.content ?? ''}`)
          .join('\n\n')
        return base ? `${base}\n\n${formatted}` : formatted
      }

      return {
        ...e,
        content: e.content.map((c) => ({
          ...c,
          text:
            c.type === 'text'
              ? {
                  value: removeReasoningContent(
                    buildInlineText(c.text?.value ?? '.')
                  ),
                  annotations: [],
                }
              : c.text,
        })),
      }
    })
  }, [messages, prompt, uploadedFiles])

  const getMaxTokens = useCallback(() => {
    const maxTokensValue =
      selectedModel?.settings?.ctx_len?.controller_props?.value
    if (typeof maxTokensValue === 'string') {
      const parsed = parseInt(maxTokensValue, 10)
      return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
    }
    if (typeof maxTokensValue === 'number' && maxTokensValue > 0) {
      return maxTokensValue
    }
    return undefined
  }, [selectedModel?.settings?.ctx_len?.controller_props?.value])

  // Debounced calculation that includes current prompt
  const runTokenCalculation = useCallback(async () => {
    const modelId = selectedModel?.id
    const maxTokensNum = getMaxTokens()

    if (
      !modelId ||
      selectedProvider !== 'llamacpp' ||
      messagesWithPrompt.length === 0
    ) {
      setTokenData({
        tokenCount: 0,
        maxTokens: maxTokensNum,
        loading: false,
        isNearLimit: false,
      })
      return
    }

    if (inFlightRef.current) {
      needsRecalcRef.current = true
      console.debug('[TokenCounter] skipping — call already in flight')
      return
    }

    inFlightRef.current = true
    needsRecalcRef.current = false

    console.debug('[TokenCounter] calculating', {
      modelId,
      provider: selectedProvider,
      messagesCount: messagesWithPrompt.length,
      maxTokensNum,
      ctxLenRaw: selectedModel?.settings?.ctx_len,
    })

    setTokenData((prev) => ({ ...prev, loading: true, error: undefined, maxTokens: maxTokensNum }))

    try {
      const tokenCount = await serviceHub
        .models()
        .getTokensCount(modelId, messagesWithPrompt)

      console.debug('[TokenCounter] result', { tokenCount, maxTokensNum })

      const percentage = maxTokensNum
        ? (tokenCount / maxTokensNum) * 100
        : undefined
      const isNearLimit = percentage ? percentage > 85 : false

      setTokenData({
        tokenCount,
        maxTokens: maxTokensNum,
        percentage,
        isNearLimit,
        loading: false,
      })
    } catch (error) {
      console.error('[TokenCounter] failed to calculate tokens:', error)

      setTokenData((prev) => ({
        ...prev,
        maxTokens: maxTokensNum,
        loading: false,
        error:
          error instanceof Error ? error.message : 'Failed to calculate tokens',
      }))
    } finally {
      inFlightRef.current = false
      if (needsRecalcRef.current) {
        needsRecalcRef.current = false
        console.debug('[TokenCounter] re-running queued calculation')
        void latestCalculationRef.current?.()
      }
    }
  }, [
    selectedModel?.id,
    selectedProvider,
    messagesWithPrompt,
    serviceHub,
    getMaxTokens,
  ])

  useEffect(() => {
    latestCalculationRef.current = runTokenCalculation
  }, [runTokenCalculation])

  // Debounced effect that triggers when prompt or messages change
  useEffect(() => {
    // Clear existing timeout
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current)
    }

    // Skip calculation if we're currently increasing context size
    if (isIncreasingContextSize.current) {
      return
    }

    // Only calculate if we have messages or a prompt
    if (
      messagesWithPrompt.length > 0 &&
      selectedProvider === 'llamacpp' &&
      selectedModel?.id
    ) {
      debounceTimeoutRef.current = setTimeout(() => {
        void latestCalculationRef.current?.()
      }, 500) // 500ms debounce to reduce repeated token calculations
    } else {
      setTokenData({
        tokenCount: 0,
        maxTokens: getMaxTokens(),
        loading: false,
        isNearLimit: false,
      })
    }

    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current)
      }
    }
  }, [
    prompt,
    messages.length,
    selectedModel?.id,
    selectedProvider,
    messagesWithPrompt.length,
    messagesWithPrompt,
    getMaxTokens,
  ])

  // Manual calculation function (for click events)
  const calculateTokens = useCallback(async () => {
    // Trigger the debounced calculation immediately
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current)
    }
    await latestCalculationRef.current?.()
  }, [])

  return {
    ...tokenData,
    calculateTokens,
  }
}
