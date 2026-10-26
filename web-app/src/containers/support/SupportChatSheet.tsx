import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react'
import { MessageCircle, Send, X } from 'lucide-react'

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { SUPPORT_MESSAGE_MAX_LENGTH } from '@/constants/support'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import {
  retrySupportMessage,
  sendSupportMessage,
  useSupportChatStore,
  type SupportChatMessage,
} from '@/stores/support-chat-store'

const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate()

/** "14:05" today, "Oct 24, 14:05" before. Empty for an unreadable time. */
const formatMessageTime = (iso: string, locale?: string): string => {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  try {
    return new Intl.DateTimeFormat(
      locale,
      sameDay(date, new Date())
        ? { hour: 'numeric', minute: '2-digit' }
        : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
    ).format(date)
  } catch {
    return date.toLocaleTimeString()
  }
}

function SupportMessage({
  message,
  locale,
}: {
  message: SupportChatMessage
  locale?: string
}) {
  const { t } = useTranslation()
  const time = formatMessageTime(message.createdAt, locale)

  if (message.author === 'team') {
    return (
      <li className="flex flex-col items-start gap-1">
        <div className="flex items-baseline gap-1.5 px-0.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/80">
            {t('common:support.teamName')}
          </span>
          {time && <time dateTime={message.createdAt}>{time}</time>}
        </div>
        <div className="max-w-[85%] rounded-xl rounded-tl-sm bg-secondary p-3.5 text-sm leading-relaxed whitespace-pre-wrap break-words text-secondary-foreground">
          {message.text}
        </div>
      </li>
    )
  }

  return (
    <li className="flex flex-col items-end gap-1" data-status={message.status}>
      <div
        className={cn(
          'max-w-[85%] rounded-xl rounded-tr-sm bg-primary px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words text-primary-foreground transition-opacity',
          message.status === 'pending' && 'opacity-60'
        )}
      >
        {message.text}
      </div>
      <div className="flex items-center gap-2 px-0.5 text-xs text-muted-foreground">
        {message.status === 'pending' && (
          <span>{t('common:support.sending')}</span>
        )}
        {message.status === 'failed' && (
          <>
            <span className="text-destructive">
              {message.error === 'rate_limited'
                ? t('common:support.rateLimited')
                : t('common:support.notSent')}
            </span>
            {message.clientId && (
              <button
                type="button"
                className="font-medium text-foreground underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
                onClick={() => void retrySupportMessage(message.clientId!)}
              >
                {t('common:support.retry')}
              </button>
            )}
          </>
        )}
        {message.status === 'sent' && time && (
          <time dateTime={message.createdAt}>{time}</time>
        )}
      </div>
    </li>
  )
}

function SupportThread() {
  const { t, i18n } = useTranslation()
  const messages = useSupportChatStore((state) => state.messages)
  const scroller = useRef<HTMLDivElement>(null)
  const last = messages[messages.length - 1]

  // Follow the conversation: a new message, or the last one changing state.
  useEffect(() => {
    const element = scroller.current
    if (element) element.scrollTop = element.scrollHeight
  }, [messages.length, last?.id, last?.status, last?.text])

  return (
    <div
      ref={scroller}
      className="min-h-0 flex-1 overflow-y-auto p-5"
      data-testid="support-chat-thread"
    >
      <div className="mb-3 flex size-9 items-center justify-center rounded-xl bg-secondary text-secondary-foreground">
        <MessageCircle size={19} />
      </div>
      <div className="max-w-[85%] rounded-xl rounded-tl-sm bg-secondary p-3.5 text-sm leading-relaxed text-secondary-foreground">
        {t('common:support.greeting')}
      </div>
      {messages.length > 0 && (
        <ol
          className="mt-4 flex flex-col gap-3"
          aria-label={t('common:support.messages')}
          aria-live="polite"
        >
          {messages.map((message) => (
            <SupportMessage
              key={message.clientId ?? message.id}
              message={message}
              locale={i18n?.language}
            />
          ))}
        </ol>
      )}
    </div>
  )
}

function SupportComposer({
  inputRef,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>
}) {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const canSend = text.trim().length > 0

  const submit = () => {
    if (!canSend) return
    void sendSupportMessage(text)
    setText('')
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return
    if (event.nativeEvent.isComposing) return
    event.preventDefault()
    submit()
  }

  return (
    <div className="m-4 mt-0">
      <div className="rounded-xl border border-border bg-card p-3 text-card-foreground">
        <textarea
          ref={inputRef}
          aria-label={t('common:support.inputLabel')}
          placeholder={t('common:support.placeholder')}
          value={text}
          maxLength={SUPPORT_MESSAGE_MAX_LENGTH}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          className="min-h-20 w-full resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {t('common:navigation.helpTitle')}
          </span>
          <button
            type="button"
            disabled={!canSend}
            aria-label={t('common:support.send')}
            onClick={submit}
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-40"
          >
            <Send size={15} />
          </button>
        </div>
      </div>
      <p className="mt-2 px-1 text-xs leading-snug text-muted-foreground">
        {t('common:support.disclosure')}
      </p>
    </div>
  )
}

/**
 * Help → Chat with us: a conversation with the Atomic Chat team. Open state
 * lives in the support-chat store, so `useSupportChatSync` knows whether a
 * reply is being watched.
 */
export function SupportChatSheet() {
  const { t } = useTranslation()
  const open = useSupportChatStore((state) => state.sheetOpen)
  const setOpen = useSupportChatStore((state) => state.setSheetOpen)
  const input = useRef<HTMLTextAreaElement>(null)

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        side="right"
        showCloseButton={false}
        data-testid="support-chat-sheet"
        className="flex w-[380px] max-w-[calc(100vw-60px)] flex-col bg-background p-0"
        onOpenAutoFocus={(event) => {
          // Straight to the composer, not the close button.
          event.preventDefault()
          input.current?.focus()
        }}
      >
        <SheetHeader className="flex-row items-start justify-between border-b border-border p-5">
          <div>
            <SheetTitle className="font-studio text-lg">
              {t('common:support.title')}
            </SheetTitle>
            <SheetDescription className="mt-1">
              {t('common:support.subtitle')}
            </SheetDescription>
          </div>
          <button
            type="button"
            aria-label={t('common:support.close')}
            onClick={() => setOpen(false)}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <X size={18} />
          </button>
        </SheetHeader>
        <SupportThread />
        <SupportComposer inputRef={input} />
      </SheetContent>
    </Sheet>
  )
}
