import {
  memo,
  useState,
  useCallback,
  type ComponentPropsWithoutRef,
} from 'react'
import type { UIMessage, ChatStatus } from 'ai'
import { RenderMarkdown } from './RenderMarkdown'
import { cn } from '@/lib/utils'
import { twMerge } from 'tailwind-merge'
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from '@/components/ai-elements/reasoning'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { Tool } from '@/components/ai-elements/tools/tool'
import { CopyButton } from './CopyButton'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { IconPencil, IconRefresh } from '@tabler/icons-react'
import { AudioPlayer } from '@/containers/AudioPlayer'
import { InlineMessageEditor } from '@/containers/InlineMessageEditor'
import { DeleteMessageDialog } from '@/containers/dialogs/DeleteMessageDialog'
import TokenSpeedIndicator from '@/containers/TokenSpeedIndicator'
import { extractFilesFromPrompt, FileMetadata } from '@/lib/fileMetadata'
import { AttachmentChip } from '@/containers/AttachmentChip'
import { useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { buildTraceBlocks } from '@/lib/tools/message-trace-parts'
import { ToolRenderer } from '@/components/ai-elements/tools/tool-renderer'
import { TraceBlock } from '@/lib/tools/types'
import {
  ActivityDetail,
  AgentActivity,
} from '@/components/ai-elements/agent-activity'
import {
  agentFilePathFromHref,
  type AgentFileReference,
  extractAgentToolPaths,
  linkAgentFileReferences,
} from '@/lib/agent-file-links'
import { useServiceHub } from '@/hooks/useServiceHub'

const CHAT_STATUS = {
  STREAMING: 'streaming',
  SUBMITTED: 'submitted',
} as const

const CONTENT_TYPE = {
  TEXT: 'text',
  FILE: 'file',
} as const

type TextTraceBlock = Extract<TraceBlock, { kind: 'text' }>
type FileTraceBlock = Extract<TraceBlock, { kind: 'file' }>
type AudioTraceBlock = Extract<TraceBlock, { kind: 'audio' }>
type ActivityTraceBlock = Extract<TraceBlock, { kind: 'activity' }>
type ReasoningTraceBlock = Extract<TraceBlock, { kind: 'reasoning' }>

export type MessageItemProps = {
  message: UIMessage
  isFirstMessage: boolean
  isLastMessage: boolean
  status: ChatStatus
  requestActive?: boolean
  reasoningContainerRef?: React.RefObject<HTMLDivElement | null>
  onRegenerate?: (messageId: string) => void
  onEdit?: (messageId: string, newText: string) => void
  onDelete?: (messageId: string) => void
  assistant?: { avatar?: React.ReactNode; name?: string }
  showAssistant?: boolean
  isAnimating?: boolean
  hideActions?: boolean
  agentAttachmentReferences?: readonly AgentFileReference[]
}

export const MessageItem = memo(
  ({
    message,
    isLastMessage,
    status,
    requestActive,
    isAnimating,
    hideActions,
    reasoningContainerRef,
    onRegenerate,
    onEdit,
    onDelete,
    agentAttachmentReferences = [],
  }: MessageItemProps) => {
    const { t } = useTranslation('chat')
    const serviceHub = useServiceHub()
    const selectedModel = useModelProvider((state) => state.selectedModel)
    // Global "Disable reasoning" toggle: some providers (e.g. MiniMax) ignore
    // every known API flag and keep streaming chain-of-thought. Hide those
    // parts in the UI so the experience matches the user's intent.
    const disableReasoning = useGeneralSetting(
      (state) => state.disableReasoning
    )
    const [previewImage, setPreviewImage] = useState<{
      url: string
      filename?: string
    } | null>(null)
    // Editing state is deliberately local: the memo comparator below does not
    // compare `onEdit` or any edit prop, so an `editingMessageId` lifted to the
    // thread route would go stale for every non-last message.
    const [isEditing, setIsEditing] = useState(false)

    const handleRegenerate = useCallback(() => {
      onRegenerate?.(message.id)
    }, [onRegenerate, message.id])

    const handleEditSave = useCallback(
      (newText: string) => {
        setIsEditing(false)
        onEdit?.(message.id, newText)
      },
      [onEdit, message.id]
    )

    const handleEditCancel = useCallback(() => setIsEditing(false), [])

    const handleDelete = useCallback(() => {
      onDelete?.(message.id)
    }, [onDelete, message.id])

    const getThinkingMessage = useCallback(
      (thinking: boolean, duration?: number) => {
        if (thinking) {
          return <Shimmer duration={1}>{t('activity.thinking')}</Shimmer>
        }
        if (!duration) {
          return <p>{t('activity.reasoned')}</p>
        }
        return <p>{t('activity.thoughtFor', { count: duration })}</p>
      },
      [t]
    )

    const isStreaming = isLastMessage && status === CHAT_STATUS.STREAMING
    const isRequestActive =
      isLastMessage &&
      message.role === 'assistant' &&
      (requestActive ??
        (status === CHAT_STATUS.STREAMING || status === CHAT_STATUS.SUBMITTED))
    const isAgentMessage = Boolean(
      (message.metadata as { agent_run?: unknown } | undefined)?.agent_run
    )
    const agentFileReferences = useMemo(
      () =>
        isAgentMessage
          ? [
              ...agentAttachmentReferences,
              ...extractAgentToolPaths(message.parts),
            ]
          : [],
      [agentAttachmentReferences, isAgentMessage, message.parts]
    )
    const agentMarkdownComponents = useMemo(
      () =>
        isAgentMessage
          ? {
              a: ({
                href,
                children,
                ...props
              }: ComponentPropsWithoutRef<'a'>) => {
                const filePath = href ? agentFilePathFromHref(href) : null
                if (!filePath) {
                  return (
                    <a href={href} {...props}>
                      {children}
                    </a>
                  )
                }

                return (
                  <a
                    href={href}
                    {...props}
                    onClick={(event) => {
                      event.preventDefault()
                      void serviceHub
                        .opener()
                        .openPath(filePath)
                        .catch((error) => {
                          console.error('Failed to open Agent file:', error)
                        })
                    }}
                  >
                    {children}
                  </a>
                )
              },
            }
          : undefined,
      [isAgentMessage, serviceHub]
    )

    // Extract file metadata from message text (for user messages with attachments)
    const attachedFiles = useMemo(() => {
      if (message.role !== 'user') return []

      const textParts = message.parts.filter(
        (part): part is { type: 'text'; text: string } =>
          part.type === CONTENT_TYPE.TEXT
      )

      if (textParts.length === 0) return []

      const { files } = extractFilesFromPrompt(textParts[0].text)
      return files
    }, [message.parts, message.role])

    // Get full text content for copy button
    const getFullTextContent = useCallback(() => {
      return message.parts
        .filter(
          (part): part is { type: 'text'; text: string } =>
            part.type === CONTENT_TYPE.TEXT
        )
        .map((part) => part.text)
        .join('\n')
    }, [message.parts])

    const renderEditor = (key: string) => {
      const editor = (
        <InlineMessageEditor
          initialText={getFullTextContent()}
          onSave={handleEditSave}
          onCancel={handleEditCancel}
        />
      )

      if (message.role !== 'user') {
        return (
          <div key={key} className="w-full">
            {editor}
          </div>
        )
      }

      return (
        <div key={key} className="w-full">
          <div className="flex justify-end w-full text-start">
            {/* `w-full` instead of the bubble's `inline-block`, so clearing the
                text does not collapse the box to caret width. */}
            <div className="bg-secondary relative text-foreground p-2 rounded-md w-full max-w-[80%]">
              {attachedFiles.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-3">
                  {attachedFiles.map((file: FileMetadata, idx: number) => (
                    <AttachmentChip
                      key={`file-${idx}-${file.id}`}
                      name={file.name}
                      fileType={file.type}
                      size={file.size}
                    />
                  ))}
                </div>
              )}
              {editor}
            </div>
          </div>
        </div>
      )
    }

    const renderTextBlock = (block: TextTraceBlock, index: number) => {
      const isLastBlock = index === traceBlocks.length - 1
      const displayText =
        message.role === 'user'
          ? extractFilesFromPrompt(block.text).cleanPrompt
          : block.text

      if (
        !displayText.trim() &&
        message.role === 'user' &&
        attachedFiles.length === 0
      ) {
        return null
      }

      // The editor owns the whole message text, because that is what the save
      // handler writes back: a single text part. So only the first text block
      // turns into an editor, and the rest are folded into it.
      if (isEditing) {
        if (block.key !== firstTextBlockKey) return null
        return renderEditor(block.key)
      }

      return (
        <div key={block.key} className="w-full">
          {message.role === 'user' ? (
            <div className="flex justify-end w-full h-full text-start wrap-break-word whitespace-normal">
              <div className="bg-secondary relative text-foreground p-2 rounded-md inline-block max-w-[80%]">
                {attachedFiles.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-3">
                    {attachedFiles.map((file: FileMetadata, idx: number) => (
                      <AttachmentChip
                        key={`file-${idx}-${file.id}`}
                        name={file.name}
                        fileType={file.type}
                        size={file.size}
                      />
                    ))}
                  </div>
                )}
                {displayText && (
                  <div dir="auto" className="select-text whitespace-pre-wrap">
                    {displayText}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <RenderMarkdown
              content={
                isAgentMessage
                  ? linkAgentFileReferences(block.text, agentFileReferences)
                  : block.text
              }
              components={agentMarkdownComponents}
              // The thread page reports `submitted` for the whole request, so
              // `status === 'streaming'` alone would leave HTML artifacts
              // thinking they are complete and re-render the iframe per token.
              isStreaming={(isStreaming || isRequestActive) && isLastBlock}
              messageId={message.id}
              isAnimating={isAnimating}
              enableHtmlPreview
            />
          )}
        </div>
      )
    }

    const renderFileBlock = (block: FileTraceBlock) => {
      return (
        <div
          key={block.key}
          className={cn(
            'flex w-full mt-2 mb-2',
            message.role === 'user' ? 'justify-end' : 'justify-start'
          )}
        >
          <button
            type="button"
            className="block overflow-hidden rounded-md border border-border max-w-[80%] cursor-pointer"
            onClick={() =>
              setPreviewImage({ url: block.url, filename: block.filename })
            }
          >
            <img
              src={block.url}
              alt={block.filename || 'Attached image'}
              className="max-h-80 w-auto object-contain"
            />
          </button>
        </div>
      )
    }

    const renderAudioBlock = (block: AudioTraceBlock) => {
      return (
        <div
          key={block.key}
          className={cn(
            'flex w-full mt-2 mb-2',
            message.role === 'user' ? 'justify-end' : 'justify-start'
          )}
        >
          <AudioPlayer
            src={block.url}
            mediaType={block.mediaType}
            filename={block.filename}
            className="w-80 max-w-[80%]"
          />
        </div>
      )
    }

    const renderReasoningBlock = (block: ReasoningTraceBlock) => {
      const streaming = isRequestActive && block.streaming

      return (
        <Reasoning
          key={block.key}
          className="mb-3"
          isStreaming={streaming}
          defaultOpen={streaming}
        >
          <ReasoningTrigger getThinkingMessage={getThinkingMessage} />
          <div
            ref={streaming ? reasoningContainerRef : null}
            className={twMerge(
              'relative w-full overflow-auto',
              streaming
                ? 'mt-2 max-h-32 opacity-70 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden [mask-image:linear-gradient(to_bottom,transparent,black_1.5rem)]'
                : 'h-auto opacity-100'
            )}
          >
            {block.items.map((item) => (
              <ReasoningContent key={item.key}>{item.text}</ReasoningContent>
            ))}
          </div>
        </Reasoning>
      )
    }

    const renderActivityBlock = (block: ActivityTraceBlock) => {
      const agentStatus = block.agentSummary?.status
      const active =
        isRequestActive &&
        (!agentStatus ||
          agentStatus === 'running' ||
          agentStatus === 'awaiting_approval')
      const summaryToolCount =
        block.agentSummary?.tools.filter(
          ({ tool }) => tool !== 'reply' && tool !== 'finish'
        ).length ?? 0
      const toolCount = block.tools.length || summaryToolCount
      const durationSeconds = Number(
        Math.max(0.1, (block.durationMs ?? 100) / 1000).toFixed(1)
      )

      return (
        <AgentActivity
          key={block.key}
          active={active}
          workingLabel={t('activity.working')}
          durationLabel={t('activity.workedFor', {
            count: durationSeconds,
          })}
          hasDetails={toolCount > 0}
        >
          {toolCount > 0 && (
            <ActivityDetail
              label={t(
                toolCount === 1
                  ? 'activity.calledTool'
                  : 'activity.calledTools',
                { count: toolCount }
              )}
            >
              {block.tools.map((tool) => (
                <Tool key={tool.key} state={tool.state} className="py-1">
                  <ToolRenderer
                    presentation={tool.presentation}
                    state={tool.state}
                  />
                </Tool>
              ))}
            </ActivityDetail>
          )}
          {block.agentSummary?.loops.map((loop, index) => (
            <div
              key={`${block.key}-loop-${index}`}
              className="py-1 text-xs text-muted-foreground"
            >
              {loop.message}
            </div>
          ))}
          {block.agentSummary?.error && (
            <div className="py-1 text-xs text-destructive">
              {block.agentSummary.error.category}:{' '}
              {block.agentSummary.error.message}
            </div>
          )}
        </AgentActivity>
      )
    }

    const traceBlocks = useMemo(
      () =>
        buildTraceBlocks(message, disableReasoning, {
          ensureActivity: isRequestActive,
        }),
      [message, disableReasoning, isRequestActive]
    )

    // A message with only attachments has no text block to anchor the editor
    // to — `buildTraceBlocks` drops blank text parts — so it gets a standalone
    // editor appended below the blocks instead.
    const firstTextBlockKey = useMemo(
      () => traceBlocks.find((block) => block.kind === 'text')?.key,
      [traceBlocks]
    )

    return (
      <div className="w-full mb-4">
        {/* Render message parts */}
        {traceBlocks.map((block, index) => {
          switch (block.kind) {
            case 'text':
              return renderTextBlock(block, index)
            case 'file':
              return renderFileBlock(block)
            case 'audio':
              return renderAudioBlock(block)
            case 'reasoning':
              return renderReasoningBlock(block)
            case 'activity':
              return renderActivityBlock(block)
            default:
              return null
          }
        })}

        {isEditing && !firstTextBlockKey && renderEditor('inline-editor')}

        {/* Message actions for user messages */}
        {message.role === 'user' && !hideActions && !isEditing && (
          <div className="flex items-center justify-end gap-1 text-muted-foreground text-xs mt-4">
            <CopyButton text={getFullTextContent()} />

            {onEdit && status !== CHAT_STATUS.STREAMING && (
              <Button
                variant="ghost"
                size="icon-xs"
                role="button"
                tabIndex={0}
                disabled={!selectedModel}
                title={t('common:editMessage')}
                aria-label={t('common:editMessage')}
                onClick={() => setIsEditing(true)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setIsEditing(true)
                  }
                }}
              >
                <IconPencil size={16} />
              </Button>
            )}

            {onDelete && status !== CHAT_STATUS.STREAMING && (
              <DeleteMessageDialog onDelete={handleDelete} />
            )}
          </div>
        )}

        {/* Message actions for assistant messages (non-tool) */}
        {message.role === 'assistant' && (
          <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs mt-1">
            <div
              className={cn(
                'flex items-center gap-1',
                (isRequestActive || hideActions || isEditing) && 'hidden'
              )}
            >
              <CopyButton text={getFullTextContent()} />

              {onEdit && !isStreaming && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  role="button"
                  tabIndex={0}
                  title={t('common:editMessage')}
                  aria-label={t('common:editMessage')}
                  onClick={() => setIsEditing(true)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setIsEditing(true)
                    }
                  }}
                >
                  <IconPencil size={16} />
                </Button>
              )}

              {onDelete && !isStreaming && (
                <DeleteMessageDialog onDelete={handleDelete} />
              )}

              {selectedModel &&
                onRegenerate &&
                !isStreaming &&
                isLastMessage && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={handleRegenerate}
                    title="Regenerate response"
                  >
                    <IconRefresh size={16} />
                  </Button>
                )}
            </div>

            {!isRequestActive && (
              <TokenSpeedIndicator
                streaming={false}
                metadata={
                  message.metadata as Record<string, unknown> | undefined
                }
              />
            )}
          </div>
        )}

        {/* Image Preview Dialog */}
        {previewImage && (
          <div
            className="fixed inset-0 z-100 bg-black/50 backdrop-blur-md flex items-center justify-center cursor-pointer"
            onClick={() => setPreviewImage(null)}
          >
            <img
              src={previewImage.url}
              alt={previewImage.filename || 'Preview'}
              className="max-h-[90vh] max-w-[90vw] object-contain"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        )}
      </div>
    )
  },
  (prevProps, nextProps) => {
    // Always re-render if streaming and this is the last message
    if (
      nextProps.isLastMessage &&
      (nextProps.status === CHAT_STATUS.STREAMING ||
        nextProps.status === CHAT_STATUS.SUBMITTED)
    ) {
      return false
    }

    return (
      prevProps.message === nextProps.message &&
      prevProps.isFirstMessage === nextProps.isFirstMessage &&
      prevProps.isLastMessage === nextProps.isLastMessage &&
      prevProps.status === nextProps.status &&
      prevProps.requestActive === nextProps.requestActive &&
      prevProps.showAssistant === nextProps.showAssistant &&
      prevProps.hideActions === nextProps.hideActions &&
      prevProps.agentAttachmentReferences ===
        nextProps.agentAttachmentReferences
    )
  }
)

MessageItem.displayName = 'MessageItem'
