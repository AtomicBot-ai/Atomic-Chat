import { useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import SettingsMenu from '@/containers/SettingsMenu'
import HeaderPage from '@/containers/HeaderPage'
import { Switch } from '@/components/ui/switch'
import { Card, CardItem } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useAnalytic } from '@/hooks/useAnalytic'
import posthog from 'posthog-js'
import {
  createPrivacyState,
  readPrivacyGateSettings,
  redactText,
  writePrivacyGateSettings,
  type PrivacyGateSettings,
} from '@/lib/privacy-gate'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.privacy as any)({
  component: Privacy,
})

function Privacy() {
  const { t } = useTranslation()
  const { setProductAnalytic, productAnalytic } = useAnalytic()
  const [privacyGate, setPrivacyGate] = useState<PrivacyGateSettings>(() =>
    readPrivacyGateSettings()
  )
  const [customTermsDraft, setCustomTermsDraft] = useState(() =>
    privacyGate.customTerms.join('\n')
  )
  const [previewInput, setPreviewInput] = useState(
    'Email chef@example.com from 10.1.2.3 and keep Project Falcon private.'
  )

  const updatePrivacyGate = (next: PrivacyGateSettings) => {
    setPrivacyGate(next)
    writePrivacyGateSettings(next)
  }

  const preview = useMemo(() => {
    const state = createPrivacyState(privacyGate.customTerms, 'preview')
    return redactText(previewInput, state)
  }, [previewInput, privacyGate.customTerms])

  return (
    <div className="flex flex-col h-svh w-full">
      <HeaderPage>
        <div className="flex items-center gap-2 w-full">
          <span className="font-medium text-base font-studio">
            {t('common:settings')}
          </span>
        </div>
      </HeaderPage>
      <div className="flex h-[calc(100%-60px)]">
        <SettingsMenu />
        <div className="p-4 pt-0 w-full overflow-y-auto">
          <div className="flex flex-col justify-between gap-4 gap-y-3 w-full">
            <Card
              header={
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h1 className="font-medium text-foreground text-base">
                      Cloud privacy gate
                    </h1>
                    <p className="text-sm text-muted-foreground mt-1">
                      Redact common secrets and identifying values before
                      messages leave Radium for a remote model.
                    </p>
                  </div>
                  <Switch
                    checked={privacyGate.enabled}
                    onCheckedChange={(enabled) =>
                      updatePrivacyGate({ ...privacyGate, enabled })
                    }
                  />
                </div>
              }
            >
              <CardItem
                title="Remote providers only"
                description={
                  <p>
                    Local inference stays untouched. When enabled, remote chat
                    requests use request-scoped placeholders and the response is
                    restored locally before it reaches the transcript or tools.
                  </p>
                }
                align="start"
              />
              <CardItem
                title="Custom private terms"
                description={
                  <div className="w-full space-y-2">
                    <p className="text-sm text-muted-foreground">
                      One term per line. Use this for client names, project
                      codenames, internal hosts, or other values the built-in
                      detectors cannot identify.
                    </p>
                    <textarea
                      className="w-full min-h-24 rounded-md border border-border bg-background px-3 py-2 text-sm"
                      value={customTermsDraft}
                      placeholder={'Project Falcon\nClient Northstar'}
                      onChange={(event) => {
                        setCustomTermsDraft(event.target.value)
                        updatePrivacyGate({
                          ...privacyGate,
                          customTerms: event.target.value
                            .split(/\r?\n/)
                            .map((term) => term.trim())
                            .filter(Boolean),
                        })
                      }}
                    />
                  </div>
                }
                align="start"
              />
              <CardItem
                title="Restore placeholders in responses"
                description={
                  <div className="flex items-center justify-between gap-4 w-full">
                    <p className="text-sm text-muted-foreground">
                      Keep real values local while showing the normal text again
                      in model replies and local tool arguments.
                    </p>
                    <Switch
                      checked={privacyGate.rehydrateResponses}
                      onCheckedChange={(rehydrateResponses) =>
                        updatePrivacyGate({
                          ...privacyGate,
                          rehydrateResponses,
                        })
                      }
                    />
                  </div>
                }
                align="start"
              />
              <CardItem
                title="Local preview"
                description={
                  <div className="w-full grid gap-2">
                    <textarea
                      className="w-full min-h-20 rounded-md border border-border bg-background px-3 py-2 text-sm"
                      value={previewInput}
                      onChange={(event) => setPreviewInput(event.target.value)}
                    />
                    <pre className="whitespace-pre-wrap break-words rounded-md bg-secondary/60 px-3 py-2 text-xs text-foreground">
                      {preview}
                    </pre>
                    <p className="text-xs text-muted-foreground">
                      Preview runs locally and does not send a request.
                    </p>
                  </div>
                }
                align="start"
              />
            </Card>

            <Card
              header={
                <div className="flex items-center justify-between mb-4">
                  <h1 className="font-medium text-foreground text-base">
                    {t('settings:privacy.analytics')}
                  </h1>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={productAnalytic}
                      onCheckedChange={(state) => {
                        if (state) {
                          posthog.opt_in_capturing()
                        } else {
                          posthog.opt_out_capturing()
                        }
                        setProductAnalytic(state)
                      }}
                    />
                  </div>
                </div>
              }
            >
              <CardItem
                title={t('settings:privacy.helpUsImprove')}
                description={<p>{t('settings:privacy.helpUsImproveDesc')}</p>}
                align="start"
              />
              <CardItem
                description={
                  <div className="text-foreground">
                    <p>{t('settings:privacy.privacyPolicy')}</p>
                    <p className="my-1">
                      {t('settings:privacy.analyticsDesc')}
                    </p>
                    <p>{t('settings:privacy.privacyPromises')}</p>
                    <ul className="list-disc pl-4 space-y-1 mt-4">
                      <li className="font-medium">
                        {t('settings:privacy.promise1')}
                      </li>
                      <li className="font-medium">
                        {t('settings:privacy.promise2')}
                      </li>
                      <li className="font-medium">
                        {t('settings:privacy.promise3')}
                      </li>
                      <li className="font-medium">
                        {t('settings:privacy.promise4')}
                      </li>
                      <li className="font-medium">
                        {t('settings:privacy.promise5')}
                      </li>
                    </ul>
                  </div>
                }
              />
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
