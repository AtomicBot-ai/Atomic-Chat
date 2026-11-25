import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ggufMatchIds } from '@/lib/onboarding/jobs'
import { sanitizeModelId } from '@/lib/utils'
import { getCatalogSync } from '@/stores/model-catalog-store'
import { useNavigate } from '@tanstack/react-router'
import { ChevronDown } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useChatSessions } from '@/stores/chat-session-store'
import { route } from '@/constants/routes'
import { engineSettingsLink } from '@/lib/engine-settings-link'
import {
  drafters,
  drafterError,
  type DrafterChoices,
} from '@/services/drafters'
export function DrafterPicker({ model }: { model: string }) {
  const pickerId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const [attempt, retry] = useState(0)
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [state, update] = useState<DrafterChoices>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const generating = useChatSessions(
    (s) =>
      Object.values(s.requestActive).some(Boolean) ||
      Object.values(s.sessions).some((v) => v.isStreaming)
  )
  useEffect(() => {
    let active = true
    drafters
      .choices(model)
      .then((v) => {
        if (active) update(v)
      })
      .catch((e) => {
        if (active) setError(drafterError(e))
      })
    return () => {
      active = false
    }
  }, [model, attempt])
  const select = async (id: string | null) => {
    if (!state || busy || generating || state.id === id) return
    setBusy(true)
    setError('')
    try {
      await drafters.select(model, id)
      update({ ...state, id })
    } catch (e) {
      setError(drafterError(e))
    } finally {
      setBusy(false)
    }
  }
  const target = state?.target ?? state?.files[0]?.target
  const source = useMemo(() => {
    if (!state || state.source || target) return state?.source
    // Use the importer's exact variant ids for older installs with no source_repo.
    const matches = getCatalogSync().filter((repo) =>
      repo.quants?.some((q) =>
        ggufMatchIds(repo.developer, sanitizeModelId(q.model_id)).includes(
          model
        )
      )
    )
    return matches.length === 1 ? matches[0].model_name : undefined
  }, [state, target, model])

  const selectedFile = state?.files.find((file) => file.sha256 === state.id)
  const selectionLabel = selectedFile
    ? selectedFile.quant
      ? `DSpark ${selectedFile.quant}`
      : selectedFile.file
    : t(state || error ? 'hub:drafters.without' : 'common:loading')

  return (
    <div className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-x-2">
        <label
          id={`${pickerId}-label`}
          htmlFor={pickerId}
          className="text-sm text-muted-foreground"
        >
          {t('hub:drafters.drafter')}
        </label>
        {state && (
          <Button
            variant="link"
            size="sm"
            className="h-auto px-0 text-xs"
            disabled={busy}
            onClick={() =>
              void navigate({
                to: route.hub.index,
                search: { category: 'drafters', source, target },
              })
            }
          >
            {t(source || target ? 'hub:drafters.find' : 'hub:drafters.browse')}
          </Button>
        )}
      </div>
      <DropdownMenu
        onOpenChange={(open) => {
          if (open)
            trigger.current?.scrollIntoView({
              block: 'nearest',
              inline: 'nearest',
            })
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button
            ref={trigger}
            type="button"
            id={pickerId}
            aria-labelledby={`${pickerId}-label ${pickerId}-value`}
            aria-describedby={`${pickerId}-hint`}
            variant="ghost"
            size="sm"
            className="w-full min-w-0 scroll-mb-[calc(min(14rem,30dvh)+0.5rem)] justify-between rounded-md border border-input bg-transparent font-normal"
            disabled={!state?.files.length || generating || busy}
          >
            <span
              id={`${pickerId}-value`}
              className="truncate"
              title={selectedFile?.file}
            >
              {selectionLabel}
            </span>
            <ChevronDown
              aria-hidden="true"
              className="size-3.5 text-muted-foreground"
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="bottom"
          align="start"
          avoidCollisions={false}
          className="max-h-[min(14rem,30dvh,var(--radix-dropdown-menu-content-available-height))] w-(--radix-dropdown-menu-trigger-width) min-w-0 bg-popover/90 backdrop-blur-xl"
        >
          <DropdownMenuRadioGroup
            value={state?.id ?? ''}
            onValueChange={(id) => void select(id || null)}
          >
            <DropdownMenuRadioItem value="">
              {t('hub:drafters.without')}
            </DropdownMenuRadioItem>
            {state?.files.map((file) => (
              <DropdownMenuRadioItem
                key={file.sha256}
                value={file.sha256}
                textValue={file.file}
              >
                <span className="min-w-0 truncate" title={file.file}>
                  {file.file}
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <p
        id={`${pickerId}-hint`}
        className="text-xs leading-normal text-muted-foreground"
      >
        {t('hub:drafters.speedHint')}
      </p>
      {busy && (
        <p role="status" className="text-xs">
          {t('hub:drafters.applying')}
        </p>
      )}
      {error && (
        <p role="alert" className="break-words text-xs text-destructive">
          {error}
        </p>
      )}
      {!state && error && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setError('')
            retry((value) => value + 1)
          }}
        >
          {t('hub:drafters.retry')}
        </Button>
      )}
      {/update.*engine|does not support draft-dspark/i.test(error) && (
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            void navigate(
              engineSettingsLink('llamacpp-upstream', { engineUpdate: true })
            )
          }
        >
          {t('hub:drafters.update')}
        </Button>
      )}
    </div>
  )
}
