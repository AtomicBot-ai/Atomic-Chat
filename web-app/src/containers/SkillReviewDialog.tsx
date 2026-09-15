import { useMemo, useState } from 'react'
import { IconAlertTriangle } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  describeSkillPermissions,
  scanForWarnings,
} from '@/lib/review-before-use'
import { cn } from '@/lib/utils'
import type { AgentSkillDetail } from '@/services/agent/skills'

export type SkillFile = { path: string; content: string }

type SkillReviewDialogProps = {
  open: boolean
  skill: AgentSkillDetail
  /** The files bundled with the skill besides SKILL.md, for Preview and warnings. */
  scripts: SkillFile[]
  onAllow: () => void
  onCancel: () => void
}

const LEVEL_STYLE = {
  risky: 'border-destructive/40 bg-destructive/5',
  changes: 'border-amber-500/40 bg-amber-500/5',
  reads: 'border-border bg-secondary/30',
} as const

/**
 * Review before use (Task 28, decision D36): what an added skill can do, in
 * plain words and ordered by risk, any warnings with the text that raised them,
 * and Allow / Preview / Cancel. Preview only shows the full instructions and
 * scripts - as plain text, so nothing in them can render or run - and never
 * allows anything. Closing the dialog any other way is Cancel.
 */
export function SkillReviewDialog({
  open,
  skill,
  scripts,
  onAllow,
  onCancel,
}: SkillReviewDialogProps) {
  const { t } = useTranslation()
  const [previewOpen, setPreviewOpen] = useState(false)

  const permissions = useMemo(
    () =>
      describeSkillPermissions({
        requiresTools: skill.requiresTools,
        requiresScripts: skill.requiresScripts,
        dangerous: skill.dangerous,
      }),
    [skill.dangerous, skill.requiresScripts, skill.requiresTools]
  )
  const warnings = useMemo(
    () =>
      scanForWarnings(
        [skill.body, ...scripts.map((script) => script.content)].join('\n')
      ),
    [scripts, skill.body]
  )

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onCancel()
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t('review:skillTitle', { name: skill.name })}
          </DialogTitle>
          <DialogDescription>{skill.description}</DialogDescription>
        </DialogHeader>

        <section className="space-y-2">
          <h3 className="text-sm font-medium">{t('review:canDo')}</h3>
          <ul aria-label={t('review:canDo')} className="space-y-2">
            {permissions.map((permission) => (
              <li
                key={permission.id}
                className={cn(
                  'rounded-md border p-2 text-sm',
                  LEVEL_STYLE[permission.level]
                )}
              >
                <p className="font-medium">
                  {t(`review:permission.${permission.id}`)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t(`review:risk.${permission.id}`)}
                </p>
              </li>
            ))}
          </ul>
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-medium">{t('review:warningsTitle')}</h3>
          {warnings.length > 0 ? (
            <>
              <ul aria-label={t('review:warnings')} className="space-y-2">
                {warnings.map((warning) => (
                  <li
                    key={warning.id}
                    className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm"
                  >
                    <p className="flex items-center gap-1.5 font-medium">
                      <IconAlertTriangle className="size-4 shrink-0 text-destructive" />
                      {t(`review:warning.${warning.id}`)}
                    </p>
                    <code className="mt-1 block whitespace-pre-wrap break-all text-xs text-muted-foreground">
                      {warning.evidence}
                    </code>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                {t('review:warningsNotAGuarantee')}
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t('review:noWarningsNotAGuarantee')}
            </p>
          )}
        </section>

        {previewOpen && (
          <section
            aria-label={t('review:previewTitle')}
            className="space-y-2 rounded-md border p-2"
          >
            <h3 className="text-sm font-medium">{t('review:previewTitle')}</h3>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-secondary/40 p-2 text-xs">
              {skill.body}
            </pre>
            {scripts.map((script) => (
              <div key={script.path} className="space-y-1">
                <p className="font-mono text-xs font-medium">{script.path}</p>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-secondary/40 p-2 text-xs">
                  {script.content}
                </pre>
              </div>
            ))}
          </section>
        )}

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onCancel}>
            {t('review:cancel')}
          </Button>
          <Button
            variant="outline"
            aria-expanded={previewOpen}
            onClick={() => setPreviewOpen((current) => !current)}
          >
            {t('review:preview')}
          </Button>
          <Button onClick={onAllow}>{t('review:allow')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
