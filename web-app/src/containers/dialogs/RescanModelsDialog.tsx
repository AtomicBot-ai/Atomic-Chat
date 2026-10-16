import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useState } from 'react'
import { toast } from 'sonner'
import { IconLoader2, IconScan } from '@tabler/icons-react'
import { ExtensionManager } from '@/lib/extension'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { LOCAL_LLAMACPP_PROVIDER } from '@/lib/utils'

/** Shape returned by the llama.cpp extension's `rescanModels()`. */
export type ModelScanReport = {
  root: string
  found: {
    id: string
    name: string
    path: string
    origin: string
    architecture: string
    quant?: string
    mmproj?: string
  }[]
  registered: string[]
  skipped: { path: string; reason: string }[]
  hidden: { id: string; path: string; reason: string }[]
  truncated: boolean
}

type Rescannable = { rescanModels?: () => Promise<ModelScanReport> }

type Props = {
  /** Called after a scan so the page can reload the provider's models. */
  onScanned?: () => void | Promise<void>
}

/**
 * "Rescan models": find GGUFs in the models folder that have no model.yml
 * (LM Studio, Hugging Face cache, Ollama), register the chat models in place
 * and show what was found and what was skipped, with reasons.
 */
export const RescanModelsDialog = ({ onScanned }: Props) => {
  const { t } = useTranslation()
  const [scanning, setScanning] = useState(false)
  const [report, setReport] = useState<ModelScanReport | null>(null)

  const engine = ExtensionManager.getInstance().getEngine(
    LOCAL_LLAMACPP_PROVIDER
  ) as unknown as Rescannable | undefined
  if (!engine?.rescanModels) return null

  const handleScan = async () => {
    setScanning(true)
    try {
      const result = await engine.rescanModels!()
      setReport(result)
      await onScanned?.()
    } catch (error) {
      toast.error(t('providers:rescan.failed'), {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setScanning(false)
    }
  }

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        className="min-w-[8rem] justify-center"
        onClick={handleScan}
        disabled={scanning}
      >
        {scanning ? (
          <IconLoader2 size={18} className="animate-spin text-muted-foreground" />
        ) : (
          <IconScan size={18} className="text-muted-foreground" />
        )}
        <span>{t('providers:rescan.button')}</span>
      </Button>
      <Dialog open={!!report} onOpenChange={(o) => !o && setReport(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('providers:rescan.title')}</DialogTitle>
            <DialogDescription>
              {t('providers:rescan.summary', {
                found: report?.found.length ?? 0,
                registered: report?.registered.length ?? 0,
                skipped: report?.skipped.length ?? 0,
                hidden: report?.hidden.length ?? 0,
              })}
            </DialogDescription>
          </DialogHeader>
          {report && (
            <div className="max-h-[60vh] space-y-4 overflow-y-auto text-xs">
              <p className="text-muted-foreground break-all">{report.root}</p>
              {report.truncated && (
                <p className="text-amber-600">{t('providers:rescan.truncated')}</p>
              )}
              <Section title={t('providers:rescan.found')}>
                {report.found.map((m) => (
                  <li key={m.id} className="break-all">
                    <span className="font-medium">{m.name}</span>{' '}
                    <span className="text-muted-foreground">
                      {[m.architecture, m.quant, m.origin, m.mmproj ? 'mmproj' : null]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                    {report.registered.includes(m.id) && (
                      <span className="ml-1 text-emerald-600">
                        {t('providers:rescan.new')}
                      </span>
                    )}
                  </li>
                ))}
              </Section>
              <Section title={t('providers:rescan.hidden')}>
                {report.hidden.map((h) => (
                  <li key={h.id} className="break-all">
                    <span className="font-medium">{h.id}</span>{' '}
                    <span className="text-muted-foreground">— {h.reason}</span>
                  </li>
                ))}
              </Section>
              <Section title={t('providers:rescan.skipped')}>
                {report.skipped.map((s) => (
                  <li key={s.path} className="break-all">
                    <span>{s.path}</span>{' '}
                    <span className="text-muted-foreground">— {s.reason}</span>
                  </li>
                ))}
              </Section>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

const Section = ({
  title,
  children,
}: {
  title: string
  children: React.ReactNode[]
}) =>
  children.length === 0 ? null : (
    <div>
      <h3 className="mb-1 font-medium text-foreground">
        {title} ({children.length})
      </h3>
      <ul className="list-disc space-y-1 pl-4">{children}</ul>
    </div>
  )
