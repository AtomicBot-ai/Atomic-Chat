import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Cloud, Download, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ModelLogo } from '@/containers/ModelLogo'
import ProvidersAvatar from '@/containers/ProvidersAvatar'
import {
  AddCloudProviderDialog,
  selectCloudGalleryProviders,
  type CloudProviderSaveResult,
} from '@/containers/dialogs/AddCloudProviderDialog'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useHardwareTier } from '@/hooks/useHardwareTier'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useRecommendedLocalModel } from '@/hooks/useRecommendedLocalModel'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { isProviderConnected } from '@/lib/cloud-providers'
import { PlatformFeatures } from '@/lib/platform/const'
import { PlatformFeature } from '@/lib/platform/types'
import {
  captureReplyGateOutcome,
  captureReplyGateShown,
  type ReplyGateOutcome,
} from '@/lib/reply-gate-telemetry'
import {
  collectReplyModels,
  replyGateBranch,
  replyGateContext,
  type ReplyGateBranch,
  type ReplyModelOption,
  type ReplyResolution,
} from '@/lib/reply-model-gate'
import { cn } from '@/lib/utils'
import { getLastUsedModel } from '@/utils/getModelToStart'
import { isSubscriptionProvider } from '@/utils/registerRemoteProvider'
import { switchToModel } from '@/utils/switchModel'

/** The subscription this widget offers by name, beside the API-key route. */
const SUBSCRIPTION_PROVIDER = 'chatgpt'

export type ReplyModelGateResolution = {
  outcome: ReplyGateOutcome
  branch: ReplyGateBranch
  /** Widget open → this decision. */
  decidedInMs: number
  /** Wall clock of the opening, so the composer can time the wait that follows
   *  the decision — a download outlives this component's state. */
  openedAtMs: number
  /** Set when the composer resolved the model itself, without this widget
   *  (see `useReplyModelAutoStart`). */
  resolution?: ReplyResolution
  /** The model being started, for the composer's status line. */
  modelLabel?: string
}

type ReplyModelGateProps = {
  open: boolean
  /** The widget never closes itself: the composer closes it once a model can
   *  answer, and the user closes it by hand. */
  onOpenChange: (open: boolean) => void
  /**
   * A model is on its way. The composer arms its queued send on this and must
   * keep it armed after the widget closes — a download is minutes long and
   * holding a modal open for it would be hostile.
   */
  onResolved: (resolution: ReplyModelGateResolution) => void
  /** Closed with nothing chosen. The composer drops its queued send. */
  onDismissed: (resolution: ReplyModelGateResolution) => void
}

/**
 * "What do I reply with?" — asked at the moment the answer is missing.
 *
 * Replaces the red `Select a model to start chatting` line under the composer,
 * which named the problem, offered no way to solve it, and emitted no telemetry
 * because the early `return` that produced it sat in front of every capture.
 *
 * One component, three shapes, decided by what is actually on the device (see
 * `lib/reply-model-gate.ts`):
 *
 *   1. exactly one model — start it, say so, ask nothing;
 *   2. several — offer them, last used first;
 *   3. none — recommend the one that fits this hardware.
 *
 * The cloud alternatives sit beside all three, not only the third. They are not
 * a lifeboat for the empty-handed: of 153 users who connected a cloud key, 144
 * activated, and day-2 return was 58.3 % against 36.7 % — so a user who already
 * owns local models is offered them too.
 */
export function ReplyModelGate({
  open,
  onOpenChange,
  onResolved,
  onDismissed,
}: ReplyModelGateProps) {
  const [cloudDialogOpen, setCloudDialogOpen] = useState(false)
  // Which entry point opened the cloud dialog: the gallery, or the named
  // subscription button that has to land on the sign-in itself.
  const [cloudEntry, setCloudEntry] = useState<'gallery' | 'subscription'>(
    'gallery'
  )

  // Snapshot rather than live state: the widget's own actions change the
  // provider list underneath it (a cloud sign-in adds a whole catalogue), and
  // re-deciding the branch mid-interaction would swap the screen out from under
  // the user. Retaken on each opening.
  const openedAtRef = useRef(0)
  const [session, setSession] = useState<{
    options: ReplyModelOption[]
    branch: ReplyGateBranch
  } | null>(null)

  const providers = useModelProvider((state) => state.providers)
  const { tier } = useHardwareTier()

  // Read through a ref so the effects below depend on the opening alone. Both
  // callbacks are rebuilt on every parent render.
  const resolvedRef = useRef(false)
  const callbacksRef = useRef({ onResolved, onDismissed })
  useEffect(() => {
    callbacksRef.current = { onResolved, onDismissed }
  }, [onResolved, onDismissed])

  useEffect(() => {
    if (!open) return

    const snapshotProviders = useModelProvider.getState().providers
    const options = collectReplyModels(snapshotProviders, getLastUsedModel())
    const branch = replyGateBranch(options)
    const context = replyGateContext(snapshotProviders)

    openedAtRef.current = Date.now()
    resolvedRef.current = false
    setSession({ options, branch })
    captureReplyGateShown({
      branch,
      localModelCount: context.localModelCount,
      cloudProviderCount: context.cloudProviderCount,
      hasCloudConnection: context.hasCloudConnection,
      hardwareTier: tier,
    })
    // Deliberately keyed on the opening only — `tier` and the provider list
    // change while the widget is up, and re-running would re-snapshot the
    // branch and double-count the impression.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const resolve = useCallback(
    (outcome: ReplyGateOutcome) => {
      if (!session) return
      resolvedRef.current = true
      const resolution = {
        outcome,
        branch: session.branch,
        decidedInMs: Date.now() - openedAtRef.current,
        openedAtMs: openedAtRef.current,
      }
      captureReplyGateOutcome(resolution)
      callbacksRef.current.onResolved(resolution)
    },
    [session]
  )

  // A resolved widget closes because its work is under way, or because the
  // composer closed it once the model came up — not because the user gave up.
  // Only an unresolved close is a dismissal.
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next && !resolvedRef.current && session) {
        const resolution = {
          outcome: 'dismissed' as const,
          branch: session.branch,
          decidedInMs: Date.now() - openedAtRef.current,
          openedAtMs: openedAtRef.current,
        }
        captureReplyGateOutcome(resolution)
        callbacksRef.current.onDismissed(resolution)
      }
      onOpenChange(next)
    },
    [session, onOpenChange]
  )

  const openCloudDialog = (entry: 'gallery' | 'subscription') => {
    setCloudEntry(entry)
    setCloudDialogOpen(true)
  }

  const serviceHub = useServiceHub()

  const handleCloudConnected = useCallback(
    ({ providerName, modelId }: CloudProviderSaveResult) => {
      if (modelId) {
        useModelProvider.getState().selectModelProvider(providerName, modelId)
      }
      resolve(
        isSubscriptionProvider(providerName) ? 'subscription' : 'cloud_key'
      )
      if (modelId) {
        // Registers the remote provider and starts the local proxy.
        // Fire-and-forget: the composer is watching readiness, not this call.
        void switchToModel({ modelId, providerName, serviceHub }).catch(
          (error) => {
            console.error('[ReplyModelGate] cloud switch failed', error)
          }
        )
      }
    },
    [resolve, serviceHub]
  )

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-lg lg:max-w-lg xl:max-w-lg">
          {session && (
            <ReplyModelGateBody
              branch={session.branch}
              options={session.options}
              providers={providers}
              onResolve={resolve}
              onConnectCloud={() => openCloudDialog('gallery')}
              onConnectSubscription={() => openCloudDialog('subscription')}
            />
          )}
        </DialogContent>
      </Dialog>

      <AddCloudProviderDialog
        open={cloudDialogOpen}
        onOpenChange={setCloudDialogOpen}
        onKeySaved={handleCloudConnected}
        initialProviderName={
          cloudEntry === 'subscription' ? SUBSCRIPTION_PROVIDER : undefined
        }
        duringOnboarding={false}
      />
    </>
  )
}

/**
 * The widget's contents.
 *
 * Split out so it mounts only while the dialog is open: it fetches the
 * recommended model's card from Hugging Face, and that request has no business
 * firing on every composer render.
 */
function ReplyModelGateBody({
  branch,
  options,
  providers,
  onResolve,
  onConnectCloud,
  onConnectSubscription,
}: {
  branch: ReplyGateBranch
  options: ReplyModelOption[]
  providers: ModelProvider[]
  onResolve: (outcome: ReplyGateOutcome) => void
  onConnectCloud: () => void
  onConnectSubscription: () => void
}) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const selectModelProvider = useModelProvider(
    (state) => state.selectModelProvider
  )
  const [startingKey, setStartingKey] = useState<string | null>(null)

  const start = useCallback(
    (option: ReplyModelOption, outcome: ReplyGateOutcome) => {
      setStartingKey(option.key)
      // Selected up front so the composer and the model dropdown reflect the
      // choice immediately, rather than only once the engine reports back.
      selectModelProvider(option.providerName, option.modelId)
      onResolve(outcome)
      void switchToModel({
        modelId: option.modelId,
        providerName: option.providerName,
        serviceHub,
      }).catch((error) => {
        console.error('[ReplyModelGate] failed to start model', error)
      })
    },
    [onResolve, selectModelProvider, serviceHub]
  )

  // Branch 1: one model, one possible answer. Asking would be theatre.
  const autoStartTarget = branch === 'auto_start' ? options[0] : undefined
  const autoStartedRef = useRef(false)
  useEffect(() => {
    if (!autoStartTarget || autoStartedRef.current) return
    autoStartedRef.current = true
    start(autoStartTarget, 'auto_start')
  }, [autoStartTarget, start])

  const title =
    branch === 'auto_start'
      ? t('chat:replyGate.startingTitle', {
          name: autoStartTarget?.label ?? '',
        })
      : branch === 'pick'
        ? t('chat:replyGate.pickTitle')
        : t('chat:replyGate.emptyTitle')

  const description =
    branch === 'auto_start'
      ? t('chat:replyGate.startingDescription')
      : branch === 'pick'
        ? t('chat:replyGate.pickDescription')
        : t('chat:replyGate.emptyDescription')

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>

      {branch === 'auto_start' && (
        <div className="flex items-center gap-3 rounded-lg border bg-secondary/50 p-3">
          <Loader2 className="text-muted-foreground size-4 shrink-0 animate-spin" />
          <span className="truncate text-sm font-medium">
            {autoStartTarget?.label}
          </span>
        </div>
      )}

      {branch === 'pick' && (
        <div
          className="flex max-h-64 flex-col gap-2 overflow-y-auto"
          data-testid="reply-gate-options"
        >
          {options.map((option) => (
            <ReplyModelRow
              key={option.key}
              option={option}
              providers={providers}
              starting={startingKey === option.key}
              disabled={startingKey !== null}
              onSelect={() => start(option, 'picked')}
            />
          ))}
        </div>
      )}

      {branch === 'none' && (
        <RecommendedDownload onStarted={() => onResolve('download')} />
      )}

      <CloudAlternatives
        providers={providers}
        onConnectCloud={onConnectCloud}
        onConnectSubscription={onConnectSubscription}
      />
    </>
  )
}

/** One thing to answer with, as a row. */
function ReplyModelRow({
  option,
  providers,
  starting,
  disabled,
  onSelect,
}: {
  option: ReplyModelOption
  providers: ModelProvider[]
  starting: boolean
  disabled: boolean
  onSelect: () => void
}) {
  const provider = providers.find((p) => p.provider === option.providerName)

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      data-testid="reply-gate-option"
      className={cn(
        'flex items-center gap-3 rounded-lg border bg-secondary/50 p-3 text-left',
        'hover:bg-secondary focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none',
        disabled && !starting && 'opacity-50'
      )}
    >
      {/* The mark has to match the line beside it. A local row is named after
          the model, so a Qwen GGUF ran under llama.cpp put a llama next to the
          word "Qwen" — and the engine is already spelled out in the sublabel.
          A cloud row is named after the provider, where the provider mark is
          the brand. */}
      {option.kind === 'local' ? (
        <ModelLogo name={option.modelId} className="size-8 rounded-lg" />
      ) : provider ? (
        <ProvidersAvatar provider={provider} className="size-8 shrink-0" />
      ) : (
        <span className="size-8 shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium leading-tight">
          {option.label}
        </span>
        {option.sublabel && (
          <span className="text-muted-foreground block truncate text-xs">
            {option.sublabel}
          </span>
        )}
      </div>
      {starting && (
        <Loader2 className="text-muted-foreground size-4 shrink-0 animate-spin" />
      )}
    </button>
  )
}

/**
 * Branch 3: nothing on the device. The recommendation is the same one
 * onboarding's reminder makes — see `useRecommendedLocalModel` — so the user is
 * never offered two different "recommended" models by the same app.
 */
function RecommendedDownload({ onStarted }: { onStarted: () => void }) {
  const { t } = useTranslation()
  const { reminder, variant, isLoading, isDownloading, startDownload } =
    useRecommendedLocalModel()
  const downloads = useDownloadStore((state) => state.downloads)

  const progress = useMemo(() => {
    if (!variant) return null
    const entry = Object.values(downloads).find(
      (d) => d.id === variant.model_id
    )
    if (!entry || entry.total <= 0) return null
    return Math.round((entry.progress ?? 0) * 100)
  }, [downloads, variant])

  const handleDownload = () => {
    if (!startDownload()) return
    onStarted()
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border bg-secondary/50 p-3">
      {/* Through `ModelLogo` for the same reason as the rows above: it tints
          single-color marks (Liquid's LFM among them) so they survive a dark
          background, where a plain <img> paints them black. */}
      <ModelLogo
        name={reminder.repo}
        fallback="huggingface"
        className="size-8 rounded-lg"
      />
      <div className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium leading-tight">
          {reminder.title}
          {variant && (
            <span className="text-muted-foreground">
              {' '}
              ({variant.file_size})
            </span>
          )}
        </span>
        <span className="text-muted-foreground block truncate text-xs">
          {isDownloading
            ? progress !== null
              ? t('chat:replyGate.downloadingPercent', { percent: progress })
              : t('chat:replyGate.downloading')
            : t('chat:replyGate.recommendedForDevice')}
        </span>
      </div>
      <Button
        size="sm"
        className="shrink-0"
        disabled={isLoading || !variant || isDownloading}
        onClick={handleDownload}
      >
        <Download />
        {t('chat:replyGate.download')}
      </Button>
    </div>
  )
}

/**
 * The two cloud routes, offered in every branch.
 *
 * Each is hidden only when it cannot do anything: the gallery when no cloud
 * provider is connectable at all, the subscription when this platform cannot
 * serve the OAuth callback or the account is already signed in.
 */
function CloudAlternatives({
  providers,
  onConnectCloud,
  onConnectSubscription,
}: {
  providers: ModelProvider[]
  onConnectCloud: () => void
  onConnectSubscription: () => void
}) {
  const { t } = useTranslation()

  const hasCloudProviders = useMemo(
    () => selectCloudGalleryProviders(providers).length > 0,
    [providers]
  )

  // Kept as the provider object rather than a boolean: the button wears the
  // subscription's own mark, so the named route is recognisable at a glance
  // beside the generic cloud one.
  const subscriptionProvider = useMemo(() => {
    if (!PlatformFeatures[PlatformFeature.CHATGPT_SUBSCRIPTION])
      return undefined
    const provider = providers.find((p) => p.provider === SUBSCRIPTION_PROVIDER)
    return provider && !isProviderConnected(provider) ? provider : undefined
  }, [providers])

  if (!hasCloudProviders && !subscriptionProvider) return null

  // No "or" divider above these: it framed cloud as the fallback for people
  // with nothing, and the point of showing it in every branch is that it is a
  // peer of the local model. SetupScreen dropped the same divider for the same
  // reason (ATO-454).
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        {hasCloudProviders && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="flex-1"
            onClick={onConnectCloud}
          >
            <Cloud />
            {t('chat:replyGate.connectCloud')}
          </Button>
        )}
        {subscriptionProvider && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="flex-1"
            onClick={onConnectSubscription}
          >
            {/* Decorative: the label already names the route, and the
                avatar's own alt text would otherwise be read as part of the
                button's name. */}
            <span aria-hidden className="flex">
              <ProvidersAvatar
                provider={subscriptionProvider}
                className="size-4 shrink-0"
              />
            </span>
            {t('chat:replyGate.connectSubscription')}
          </Button>
        )}
      </div>
    </div>
  )
}

export default ReplyModelGate
