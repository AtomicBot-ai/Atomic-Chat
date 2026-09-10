import { useEffect, useMemo, useState } from 'react'
import { IconDownload, IconExternalLink, IconHeart } from '@tabler/icons-react'
import type { Components } from 'react-markdown'
import { Button } from '@/components/ui/button'
import { ModelLogo } from '@/containers/ModelLogo'
import { RenderMarkdown } from '@/containers/RenderMarkdown'
import { DownloadOptionsSelect } from '@/containers/hub/DownloadOptionsSelect'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useHardware } from '@/hooks/useHardware'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  deriveCapabilities,
  deriveContext,
  deriveParams,
  fetchModelStats,
  formatDownloads,
  getMemoryBudgetBytes,
  modelFormat,
  type ModelStats,
} from '@/lib/model-card'
import { extractModelName } from '@/lib/models'
import { cn } from '@/lib/utils'
import type { CatalogModel } from '@/services/models/types'
import type { StaffPick } from '@/services/staff-picks-registry'
import { useShallow } from 'zustand/shallow'

// HuggingFace READMEs open with a YAML frontmatter block (license, tags,
// base_model…). Without a frontmatter parser it renders as stray `---` rules
// and key/value text. `removeYamlFrontMatter` in lib/models assumes LF and no
// BOM; a README fetched over HTTP frequently has both.
const stripFrontmatter = (markdown: string): string =>
  markdown.replace(/^\uFEFF?\s*---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')

// Model cards are wallpapered with CI shields, Discord invites and hero
// banners. They are decorative at best, and at worst they are dozens of
// remote requests and a layout that jumps as each one lands. Drop every image
// node — markdown-authored and, thanks to `allowRawHtml`, HTML-authored too.
const README_COMPONENTS: Components = {
  img: () => null,
  picture: () => null,
  a: ({ ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
}

const relativeTime = (dateString?: string): string | undefined => {
  if (!dateString) return undefined
  const parsed = Date.parse(dateString)
  if (!Number.isFinite(parsed)) return undefined
  const days = Math.max(
    1,
    Math.ceil(Math.abs(Date.now() - parsed) / (1000 * 60 * 60 * 24))
  )
  if (days < 7) return `${days} days ago`
  if (days < 30) {
    const weeks = Math.floor(days / 7)
    return `${weeks} week${weeks > 1 ? 's' : ''} ago`
  }
  if (days < 365) {
    const months = Math.floor(days / 30)
    return `${months} month${months > 1 ? 's' : ''} ago`
  }
  const years = Math.floor(days / 365)
  return `${years} year${years > 1 ? 's' : ''} ago`
}

export type ModelDetailPanelProps = {
  model: CatalogModel | null
  /** Curated metadata when the selection came from staff picks. */
  pick?: StaffPick
  className?: string
}

export function ModelDetailPanel({
  model,
  pick,
  className,
}: ModelDetailPanelProps) {
  const { t } = useTranslation()
  const huggingfaceToken = useGeneralSetting((state) => state.huggingfaceToken)
  const { total_memory, gpus } = useHardware(
    useShallow((s) => ({
      total_memory: s.hardwareData.total_memory,
      gpus: s.hardwareData.gpus,
    }))
  )
  const budgetBytes = useMemo(
    () => getMemoryBudgetBytes({ total_memory, gpus }),
    [total_memory, gpus]
  )

  const [stats, setStats] = useState<ModelStats>({})
  const [readme, setReadme] = useState('')
  const [readmeLoading, setReadmeLoading] = useState(false)

  const modelName = model?.model_name
  const readmeUrl = model?.readme

  useEffect(() => {
    if (!modelName) return
    let active = true
    setStats({})
    void fetchModelStats(modelName).then((next) => {
      if (active) setStats(next)
    })
    return () => {
      active = false
    }
  }, [modelName])

  useEffect(() => {
    if (!readmeUrl) {
      setReadme('')
      return
    }
    let active = true
    setReadmeLoading(true)
    setReadme('')
    // HF rejects an Authorization header on public repos, so try anonymously
    // first and only retry with the token when the anonymous read fails.
    fetch(readmeUrl)
      .then((response) =>
        !response.ok && huggingfaceToken
          ? fetch(readmeUrl, {
              headers: { Authorization: `Bearer ${huggingfaceToken}` },
            })
          : response
      )
      .then((response) => response.text())
      .then((content) => {
        if (!active) return
        setReadme(stripFrontmatter(content))
      })
      .catch((error) => {
        console.error('Failed to fetch README:', error)
      })
      .finally(() => {
        if (active) setReadmeLoading(false)
      })
    return () => {
      active = false
    }
  }, [readmeUrl, huggingfaceToken])

  const caps = useMemo(
    () => (model ? deriveCapabilities(model, pick?.categories) : []),
    [model, pick?.categories]
  )

  if (!model) {
    return (
      <div
        className={cn(
          'flex h-full items-center justify-center p-6 text-sm text-muted-foreground',
          className
        )}
      >
        {t('hub:selectModel')}
      </div>
    )
  }

  const name = pick?.title || extractModelName(model.model_name) || model.model_name
  const repoId = model.model_name.includes('/')
    ? model.model_name
    : `${model.developer ? `${model.developer}/` : ''}${model.model_name}`
  const params = stats.params ?? deriveParams(model)
  const context = stats.context ?? deriveContext(model)
  const updated = relativeTime(model.last_modified ?? model.created_at)

  return (
    <div className={cn('flex flex-col gap-4 p-6', className)}>
      <header className="flex items-start gap-3">
        <ModelLogo
          author={model.developer}
          name={model.model_name}
          icon={pick?.icon}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="min-w-0 truncate text-xl font-semibold" title={name}>
              {name}
            </h1>
          </div>
          <p className="truncate text-xs text-muted-foreground">{repoId}</p>
        </div>
        <a
          href={`https://huggingface.co/${repoId}`}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0"
        >
          <Button variant="outline" size="sm" className="gap-1.5">
            <IconExternalLink size={14} />
            {t('hub:openOnWeb')}
          </Button>
        </a>
      </header>

      <DownloadOptionsSelect model={model} budgetBytes={budgetBytes} />

      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-3 text-sm font-medium">{t('hub:details')}</h2>
        <dl className="grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-md bg-muted/40 p-3">
            <dt className="text-muted-foreground">{t('hub:parameters')}</dt>
            <dd className="mt-1 text-sm font-semibold text-foreground">
              {params ?? '—'}
            </dd>
          </div>
          <div className="rounded-md bg-muted/40 p-3">
            <dt className="text-muted-foreground">{t('hub:context')}</dt>
            <dd className="mt-1 text-sm font-semibold text-foreground">
              {context ?? '—'}
            </dd>
          </div>
          <div className="rounded-md bg-muted/40 p-3">
            <dt className="text-muted-foreground">{t('hub:formats')}</dt>
            <dd className="mt-1 text-sm font-semibold uppercase text-foreground">
              {modelFormat(model)}
            </dd>
          </div>
          <div className="rounded-md bg-muted/40 p-3">
            <dt className="text-muted-foreground">{t('hub:capabilities')}</dt>
            <dd className="mt-1.5 flex flex-wrap gap-1.5">
              {caps.length === 0 ? (
                <span className="text-sm font-semibold text-foreground">—</span>
              ) : (
                caps.map((cap) => (
                  <span
                    key={cap.label}
                    className={cn(
                      'rounded-[5px] px-1.5 py-px text-[10px] font-semibold',
                      cap.className
                    )}
                  >
                    {cap.label}
                  </span>
                ))
              )}
            </dd>
          </div>
        </dl>
        {(!!model.downloads || !!model.likes || updated) && (
          <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border pt-3 text-xs text-muted-foreground">
            {!!model.downloads && model.downloads > 0 && (
              <span className="inline-flex items-center gap-1">
                <IconDownload size={13} />
                {formatDownloads(model.downloads)}
              </span>
            )}
            {!!model.likes && model.likes > 0 && (
              <span className="inline-flex items-center gap-1">
                <IconHeart size={13} />
                {formatDownloads(model.likes)}
              </span>
            )}
            {updated && <span>{t('hub:updatedAgo', { ago: updated })}</span>}
          </div>
        )}
      </section>

      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-3 text-sm font-medium">{t('hub:readme')}</h2>
        {readmeLoading ? (
          <p className="text-xs text-muted-foreground">
            {t('hub:loadingModels')}
          </p>
        ) : readme ? (
          <RenderMarkdown
            allowRawHtml
            isAnimating={false}
            components={README_COMPONENTS}
            content={readme}
          />
        ) : (
          <p className="text-xs text-muted-foreground">
            {t('hub:readmeUnavailable')}
          </p>
        )}
      </section>
    </div>
  )
}
