import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Cloud, FolderPlus, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ChatGptMark } from '@/components/icons/chatgpt-mark'
import { route } from '@/constants/routes'
import { ModelLogo } from '@/containers/ModelLogo'
import { RouteRow } from '@/containers/RouteRow'
import {
  AddCloudProviderDialog,
  selectCloudGalleryProviders,
  type CloudProviderSaveResult,
} from '@/containers/dialogs/AddCloudProviderDialog'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useHardwareTier } from '@/hooks/useHardwareTier'
import { useLocalScanFolder } from '@/hooks/useLocalScanFolder'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useRecommendedDownloads } from '@/hooks/useRecommendedDownloads'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { isProviderConnected } from '@/lib/cloud-providers'
import { HUGGINGFACE_LOGO_SRC } from '@/lib/model-logo'
import { extractModelErrorMessage } from '@/lib/modelErrorMessage'
import {
  importScannedModel,
  pickSmallestRunnable,
} from '@/lib/scanned-model-import'
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
  resolveReplyModel,
  type ReplyGateBranch,
  type ReplyModelOption,
  type ReplyResolution,
} from '@/lib/reply-model-gate'
import {
  collectImportedModelPaths,
  scanLocalModels,
} from '@/services/models/localScan'
import { getLastUsedModel } from '@/utils/getModelToStart'
import { isSubscriptionProvider } from '@/utils/registerRemoteProvider'
import { switchToModel } from '@/utils/switchModel'

/** The subscription this widget offers by name, beside the API-key route. */
const SUBSCRIPTION_PROVIDER = 'chatgpt'

/** How long the recommendation may take to resolve before the widget stops waiting. */
const RECOMMENDATION_WAIT_MS = 8_000

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
 * One component, two shapes, decided by what is actually on the device (see
 * `lib/reply-model-gate.ts`):
 *
 *   1. something to answer with — start the model `resolveReplyModel` picks,
 *      say so, ask nothing. There is no list to choose from: the user already
 *      said what they want by pressing Send;
 *   2. nothing — recommend the one that fits this hardware.
 *
 * The cloud alternatives sit beside both, not only the second. They are not
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
    branch: ReplyGateBranch
    target?: ReplyModelOption
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
    const lastUsed = getLastUsedModel()
    const options = collectReplyModels(snapshotProviders, lastUsed)
    const branch = replyGateBranch(options)
    const context = replyGateContext(snapshotProviders)

    openedAtRef.current = Date.now()
    resolvedRef.current = false
    setSession({ branch, target: resolveReplyModel(options, lastUsed)?.option })
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

  const navigate = useNavigate()

  // "Any model from Hugging Face" leaves for the Hub. Nothing is on its way,
  // so the composer drops its queued send like a dismissal — the text stays
  // in the composer — but the outcome is its own, not "gave up".
  const handleBrowseHub = useCallback(() => {
    if (!session) return
    resolvedRef.current = true
    const resolution = {
      outcome: 'hub' as const,
      branch: session.branch,
      decidedInMs: Date.now() - openedAtRef.current,
      openedAtMs: openedAtRef.current,
    }
    captureReplyGateOutcome(resolution)
    callbacksRef.current.onDismissed(resolution)
    onOpenChange(false)
    void navigate({ to: route.hub.index })
  }, [session, onOpenChange, navigate])

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
              target={session.target}
              providers={providers}
              onResolve={resolve}
              onConnectCloud={() => openCloudDialog('gallery')}
              onConnectSubscription={() => openCloudDialog('subscription')}
              onBrowseHub={handleBrowseHub}
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
 * Split out so it mounts only while the dialog is open: it resolves the
 * recommended models' cards from Hugging Face, and those requests have no
 * business firing on every composer render.
 */
function ReplyModelGateBody({
  branch,
  target,
  providers,
  onResolve,
  onConnectCloud,
  onConnectSubscription,
  onBrowseHub,
}: {
  branch: ReplyGateBranch
  target?: ReplyModelOption
  providers: ModelProvider[]
  onResolve: (outcome: ReplyGateOutcome) => void
  onConnectCloud: () => void
  onConnectSubscription: () => void
  onBrowseHub: () => void
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

  // Branch 1: something to answer with. The composer resolves the same way
  // before it opens the widget, so asking here would only put back a question
  // it has already answered.
  const autoStartTarget = branch === 'auto_start' ? target : undefined
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
      : t('chat:replyGate.emptyTitle')

  const description =
    branch === 'auto_start'
      ? t('chat:replyGate.startingDescription')
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

      {branch === 'none' && (
        <RecommendedDownloads onStarted={() => onResolve('download')} />
      )}

      <ModelRoutes
        providers={providers}
        onConnectCloud={onConnectCloud}
        onConnectSubscription={onConnectSubscription}
        onBrowseHub={onBrowseHub}
      />

      {branch === 'none' && (
        <AddFolderRoute
          onStarted={(option) => start(option, 'folder')}
          disabled={startingKey !== null}
        />
      )}
    </>
  )
}

/**
 * Branch 2: nothing on the device. The list is the one onboarding leads with
 * — see `useRecommendedDownloads` — so the user is never offered two different
 * "recommended" models by the same app. The first row is the best fit and
 * carries the filled button; the rest are the tier's other options.
 */
function RecommendedDownloads({ onStarted }: { onStarted: () => void }) {
  const { t } = useTranslation()
  const { items, isLoading } = useRecommendedDownloads()
  const downloads = useDownloadStore((state) => state.downloads)
  // The card lookup has no failure state of its own; past this the routes
  // below are the offer, and a spinner with nothing behind it comes down.
  const [gaveUp, setGaveUp] = useState(false)
  useEffect(() => {
    if (!isLoading || gaveUp) return
    const timer = setTimeout(() => setGaveUp(true), RECOMMENDATION_WAIT_MS)
    return () => clearTimeout(timer)
  }, [isLoading, gaveUp])

  const progressFor = (modelId: string | undefined) => {
    if (!modelId) return null
    const entry = Object.values(downloads).find((d) => d.id === modelId)
    if (!entry || entry.total <= 0) return null
    return Math.round((entry.progress ?? 0) * 100)
  }

  if (items.length === 0) {
    if (!isLoading || gaveUp) return null
    return (
      <div
        className="flex items-center gap-3 rounded-lg border bg-secondary/50 p-3"
        data-testid="reply-gate-recommended"
      >
        <Loader2 className="text-muted-foreground size-4 shrink-0 animate-spin" />
        <span className="text-muted-foreground truncate text-sm">
          {t('chat:replyGate.findingRecommendation')}
        </span>
      </div>
    )
  }

  return (
    <div
      className="rounded-lg border bg-secondary/50 px-3 py-2"
      data-testid="reply-gate-recommended"
    >
      <div className="flex flex-col divide-y divide-border/60">
        {items.map((item, index) => {
          const hero = index === 0
          const progress = progressFor(item.variant.model_id)
          const hint = item.isDownloading
            ? progress !== null
              ? t('chat:replyGate.downloadingPercent', { percent: progress })
              : t('chat:replyGate.downloading')
            : hero
              ? t('chat:replyGate.recommendedForDevice')
              : t(item.descriptionKey)
          return (
            <RouteRow
              key={item.repo}
              icon={
                // Through `ModelLogo` so single-color marks (Liquid's LFM among
                // them) are tinted and survive a dark background.
                <ModelLogo
                  name={item.repo}
                  fallback="huggingface"
                  className="size-8 rounded-full border-0 bg-transparent dark:bg-transparent"
                />
              }
              title={item.title}
              hint={hint}
              action={t('chat:replyGate.download')}
              label={t('chat:replyGate.downloadLabel', { name: item.title })}
              primary={hero}
              disabled={item.isDownloading}
              onClick={() => {
                if (!item.start()) return
                onStarted()
              }}
              data-testid={
                hero
                  ? 'reply-gate-recommended-lead'
                  : 'reply-gate-recommended-other'
              }
            />
          )
        })}
      </div>
    </div>
  )
}

/**
 * "My models are in a folder of my own."
 *
 * A third of onboarding exits are imports of models other apps left on disk,
 * and they activate best of any mass path. The scanner only knows the apps'
 * default stores; a user who keeps weights somewhere else could add the
 * folder in Settings, if they knew to look. Here the offer is made at the
 * moment it matters: pick a folder, the scanner reads it, and the lightest
 * model found is imported and started — the same rule onboarding applies.
 */
function AddFolderRoute({
  onStarted,
  disabled,
}: {
  onStarted: (option: ReplyModelOption) => void
  disabled: boolean
}) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const { pickScanFolder } = useLocalScanFolder()
  const [scanning, setScanning] = useState(false)

  const handlePick = async () => {
    const folder = await pickScanFolder()
    if (!folder) return
    setScanning(true)
    try {
      const found = await scanLocalModels({
        enabled: true,
        extraRoots: [folder],
        importedPaths: collectImportedModelPaths(
          useModelProvider.getState().providers
        ),
      })
      const cand = pickSmallestRunnable(found)
      if (!cand) {
        toast.info(t('chat:replyGate.folderEmpty'))
        return
      }
      const { providerName, modelId } = await importScannedModel(
        cand,
        serviceHub
      )
      onStarted({
        key: `${providerName}:${modelId}`,
        kind: 'local',
        providerName,
        modelId,
        label: cand.displayName,
      })
    } catch (error) {
      console.error('[ReplyModelGate] folder import failed', error)
      toast.error(extractModelErrorMessage(error))
    } finally {
      setScanning(false)
    }
  }

  return (
    <Button
      type="button"
      variant="link"
      size="sm"
      className="text-muted-foreground hover:text-foreground h-auto self-center py-1 text-xs hover:no-underline"
      disabled={disabled || scanning}
      onClick={() => void handlePick()}
      data-testid="reply-gate-add-folder"
    >
      {scanning ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <FolderPlus className="size-4" />
      )}
      {scanning
        ? t('chat:replyGate.folderScanning')
        : t('chat:replyGate.addFolder')}
    </Button>
  )
}

/**
 * The other ways to get a model, offered in every branch as rows — the same
 * rows onboarding shows, so the two screens read as one product.
 *
 * Each cloud route is hidden only when it cannot do anything: the API-key
 * route when no cloud provider is connectable at all, the subscription when
 * this platform cannot serve the OAuth callback or the account is already
 * signed in. The Hub route is always there: it is where the rest of Hugging
 * Face lives.
 *
 * No "or" divider above these: it framed cloud as the fallback for people
 * with nothing, and the point of showing it in every branch is that it is a
 * peer of the local model. SetupScreen dropped the same divider for the same
 * reason (ATO-454).
 */
function ModelRoutes({
  providers,
  onConnectCloud,
  onConnectSubscription,
  onBrowseHub,
}: {
  providers: ModelProvider[]
  onConnectCloud: () => void
  onConnectSubscription: () => void
  onBrowseHub: () => void
}) {
  const { t } = useTranslation()

  const hasCloudProviders = useMemo(
    () => selectCloudGalleryProviders(providers).length > 0,
    [providers]
  )

  const subscriptionOffered = useMemo(() => {
    if (!PlatformFeatures[PlatformFeature.CHATGPT_SUBSCRIPTION]) return false
    const provider = providers.find((p) => p.provider === SUBSCRIPTION_PROVIDER)
    return !!provider && !isProviderConnected(provider)
  }, [providers])

  return (
    <div
      className="rounded-lg border bg-secondary/50 px-3 py-2"
      data-testid="reply-gate-routes"
    >
      <div className="flex flex-col divide-y divide-border/60">
        <RouteRow
          icon={<img src={HUGGINGFACE_LOGO_SRC} alt="" />}
          title={t('setup:cloudStep.huggingFaceTitle')}
          hint={t(
            IS_MACOS
              ? 'setup:cloudStep.huggingFaceHint'
              : 'setup:cloudStep.huggingFaceHintGguf'
          )}
          action={t('setup:cloudStep.browse')}
          label={t('setup:cloudStep.huggingFaceTrigger')}
          onClick={onBrowseHub}
          data-testid="reply-gate-browse-hub"
        />
        {subscriptionOffered && (
          <RouteRow
            icon={<ChatGptMark />}
            title={t('setup:cloudStep.subscriptionTitle')}
            hint={t('setup:cloudStep.subscriptionHint')}
            action={t('setup:cloudStep.connect')}
            label={t('setup:cloudStep.subscriptionTrigger')}
            onClick={onConnectSubscription}
            data-testid="reply-gate-subscription"
          />
        )}
        {hasCloudProviders && (
          <RouteRow
            icon={<Cloud />}
            title={t('setup:cloudStep.providerTitle')}
            hint={t('setup:cloudStep.providerHint')}
            action={t('setup:cloudStep.add')}
            label={t('setup:cloudStep.trigger')}
            onClick={onConnectCloud}
            data-testid="reply-gate-cloud-key"
          />
        )}
      </div>
    </div>
  )
}
