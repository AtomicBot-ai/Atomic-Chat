import { useState } from 'react'
import { toast } from 'sonner'
import { Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ImportMlxModelDialog } from '@/containers/dialogs/ImportMlxModelDialog'
import { ImportVisionModelDialog } from '@/containers/dialogs/ImportVisionModelDialog'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { MLX_PROVIDER } from '@/lib/hub-installed'
import { LOCAL_LLAMACPP_PROVIDER } from '@/lib/utils'

const isGguf = (path: string) => /\.gguf$/i.test(path)

/**
 * The Hub's "Import file": a model already on this computer, through the same
 * import the engine pages use. A GGUF file goes to the llama.cpp import (with
 * its optional vision projector); on a Mac, an MLX model folder goes to the
 * MLX import. Anything else is refused with what can be imported instead.
 */
export function ImportLocalFile() {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const providers = useModelProvider((state) => state.providers)
  const setProviders = useModelProvider((state) => state.setProviders)
  const [ggufFile, setGgufFile] = useState<string | null>(null)
  const [mlxFolder, setMlxFolder] = useState<string | null>(null)

  // The default llama.cpp engine imports GGUF files, as on its own page.
  const ggufProvider = providers.find(
    (provider) => provider.provider === LOCAL_LLAMACPP_PROVIDER
  )
  const mlxProvider = IS_MACOS
    ? providers.find((provider) => provider.provider === MLX_PROVIDER)
    : undefined
  if (!ggufProvider && !mlxProvider) return null

  const refreshProviders = () => {
    void serviceHub
      .providers()
      .getProviders()
      .then(setProviders)
      .catch(() => {})
  }

  const pickFile = async () => {
    const picked = await serviceHub
      .dialog()
      .open({ multiple: false, directory: false })
    if (typeof picked !== 'string') return
    if (ggufProvider && isGguf(picked)) {
      setGgufFile(picked)
      return
    }
    toast.error(t('hub:import.unsupportedTitle'), {
      id: 'hub-import-unsupported',
      description: t(
        mlxProvider
          ? 'hub:import.unsupportedGgufOrMlx'
          : 'hub:import.unsupportedGguf'
      ),
    })
  }

  const pickFolder = async () => {
    const picked = await serviceHub
      .dialog()
      .open({ multiple: false, directory: true })
    if (typeof picked === 'string') setMlxFolder(picked)
  }

  // Below the toolbar's compact step the label hides and the icon stays;
  // the accessible name and the tooltip keep saying what it does.
  const name = t('hub:import.button')
  const label = (
    <>
      <Upload size={14} />
      <span className="hub-toolbar-label">{name}</span>
    </>
  )

  return (
    <>
      {mlxProvider ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="import" aria-label={name} title={name}>
              {label}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {ggufProvider && (
              <DropdownMenuItem onSelect={() => void pickFile()}>
                {t('hub:import.ggufFile')}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => void pickFolder()}>
              {t('hub:import.mlxFolder')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Button
          size="sm"
          variant="import"
          aria-label={name}
          title={name}
          onClick={() => void pickFile()}
        >
          {label}
        </Button>
      )}
      {ggufProvider && (
        <ImportVisionModelDialog
          provider={ggufProvider}
          open={ggufFile !== null}
          onOpenChange={(open) => {
            if (!open) setGgufFile(null)
          }}
          initialModelFile={ggufFile ?? undefined}
          onSuccess={refreshProviders}
        />
      )}
      {mlxProvider && (
        <ImportMlxModelDialog
          provider={mlxProvider}
          open={mlxFolder !== null}
          onOpenChange={(open) => {
            if (!open) setMlxFolder(null)
          }}
          initialPath={mlxFolder ?? undefined}
          onSuccess={refreshProviders}
        />
      )}
    </>
  )
}
