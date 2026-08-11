import { createFileRoute } from '@tanstack/react-router'
import { SettingsPageHeader } from '@/containers/SettingsPageHeader'
import { route } from '@/constants/routes'
import { Card, CardItem } from '@/containers/Card'

import { RenderMarkdown } from '@/containers/RenderMarkdown'
import { ExtensionManager } from '@/lib/extension'
import { useTranslation } from '@/i18n/react-i18next-compat'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.extensions as any)({
  component: ExtensionsContent,
})

function ExtensionsContent() {
  const { t } = useTranslation()
  const extensions = ExtensionManager.getInstance().listExtensions()
  return (
    <>
      <SettingsPageHeader>
        <div className="flex items-center gap-2 w-full">
          <span className='font-medium text-base font-studio'>{t('common:settings')}</span>
        </div>
      </SettingsPageHeader>
      <div className="p-4 pt-0 w-full overflow-y-auto">
        <div className="flex flex-col justify-between gap-4 gap-y-3 w-full">
          {/* General */}
          <Card
            header={
              <div className="flex items-center justify-between mb-4">
                <h1 className="text-foreground font-studio font-medium text-base">
                  {t('settings:extensions.title')}
                </h1>
                {/* <div className="flex items-center gap-2">
                  <Button size="sm">Install Extension</Button>
                </div> */}
              </div>
            }
          >
            {extensions.map((item, i) => {
              return (
                <CardItem
                  key={i}
                  title={
                    <div className="flex items-center gap-x-2">
                      <h1 className="text-foreground font-studio font-medium text-base">
                        {item.productName ?? item.name}
                      </h1>
                      <div className="bg-foreground/10 px-1 py-0.5 rounded text-foreground/70 text-xs">
                        v{item.version}
                      </div>
                    </div>
                  }
                  description={
                    <RenderMarkdown
                      content={item.description ?? ''}
                      components={{
                        // Make links open in a new tab
                        a: ({ ...props }) => (
                          <a
                            {...props}
                            target="_blank"
                            rel="noopener noreferrer"
                          />
                        ),
                        // Custom paragraph component remove margin
                        p: ({ ...props }) => (
                          <p {...props} className="mb-0!" />
                        ),
                      }}
                    />
                  }
                />
              )
            })}
          </Card>
        </div>
      </div>
    </>
  )
}
