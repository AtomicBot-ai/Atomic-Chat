import { IconFolderPlus, IconShieldLock, IconX } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useMCPServers } from '@/hooks/useMCPServers'
import { SYSTEM_SERVER_KEYS } from '@/constants/mcp-connectors'
import { isWebSearchServer } from '@/lib/web-search'
import type { SecureEnvironmentAvailability } from '@/hooks/useSecureEnvironments'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { SecureEnvironment } from '@/services/chat-exec/types'

type SecureEnvironmentFieldsProps = {
  /** `null`: an ordinary project. */
  value: SecureEnvironment | null
  onChange: (value: SecureEnvironment | null) => void
  availability: SecureEnvironmentAvailability
}

const folderName = (path: string) =>
  path.split(/[\\/]/).filter(Boolean).at(-1) ?? path

/**
 * The project dialog's "Secure environment" section: which folders the
 * project's commands may reach (each read-only or editable), whether they
 * may use the network, and which MCP servers its chats may call.
 */
export function SecureEnvironmentFields({
  value,
  onChange,
  availability,
}: SecureEnvironmentFieldsProps) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const mcpServers = useMCPServers((state) => state.mcpServers)

  if (availability.kind === 'hidden') return null
  // Where MXC is unavailable a secure project can still be switched off,
  // never on.
  const canEnable = availability.kind === 'available'

  const addFolders = async () => {
    if (!value) return
    const selected = await serviceHub.dialog().open({
      directory: true,
      multiple: true,
    })
    const paths = (Array.isArray(selected) ? selected : [selected]).filter(
      (path): path is string => typeof path === 'string'
    )
    const known = new Set(value.folders.map((folder) => folder.path))
    const added = paths
      .filter((path) => !known.has(path))
      .map((path) => ({ path, canEdit: true }))
    if (added.length > 0) {
      onChange({ ...value, folders: [...value.folders, ...added] })
    }
  }

  // System servers never reach a chat; a server allowed earlier but since
  // removed stays listed so it can be unticked.
  const serverKeys = [
    ...Object.keys(mcpServers).filter(
      (key) => !SYSTEM_SERVER_KEYS.includes(key)
    ),
    ...(value?.allowedMcpServers ?? []).filter((key) => !(key in mcpServers)),
  ]

  const toggleServer = (key: string, allowed: boolean) => {
    if (!value) return
    onChange({
      ...value,
      allowedMcpServers: allowed
        ? [...value.allowedMcpServers.filter((item) => item !== key), key]
        : value.allowedMcpServers.filter((item) => item !== key),
    })
  }

  return (
    <div className="min-w-0 space-y-3 rounded-md border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <label
            htmlFor="secure-environment"
            className="flex items-center gap-1.5 text-sm font-medium"
          >
            <IconShieldLock className="size-4" />
            {t('projects.secureEnvironment.title')}
          </label>
          <p className="text-xs text-muted-foreground">
            {t('projects.secureEnvironment.description')}
          </p>
          {availability.kind === 'unavailable' && (
            <p className="text-xs text-destructive">
              {t('projects.secureEnvironment.unavailable', {
                reason:
                  availability.reason ??
                  t('projects.secureEnvironment.unknownReason'),
              })}
            </p>
          )}
        </div>
        <Switch
          id="secure-environment"
          checked={value !== null}
          disabled={value === null && !canEnable}
          onCheckedChange={(checked) =>
            onChange(
              checked
                ? { folders: [], network: true, allowedMcpServers: [] }
                : null
            )
          }
        />
      </div>

      {value && (
        <>
          <div className="space-y-1.5">
            {value.folders.length === 0 && (
              <p className="text-xs text-muted-foreground">
                {t('projects.secureEnvironment.noFolders')}
              </p>
            )}
            {value.folders.map((folder) => (
              <div
                key={folder.path}
                className="flex items-center gap-2 rounded-md bg-secondary px-2 py-1.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{folderName(folder.path)}</div>
                  <div
                    className="truncate text-xs text-muted-foreground"
                    title={folder.path}
                  >
                    {folder.path}
                  </div>
                </div>
                <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                  {t('projects.secureEnvironment.canEdit')}
                  <Switch
                    checked={folder.canEdit}
                    onCheckedChange={(canEdit) =>
                      onChange({
                        ...value,
                        folders: value.folders.map((item) =>
                          item.path === folder.path ? { ...item, canEdit } : item
                        ),
                      })
                    }
                  />
                </label>
                <button
                  type="button"
                  className="shrink-0 cursor-pointer rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label={t('projects.secureEnvironment.removeFolder')}
                  title={t('projects.secureEnvironment.removeFolder')}
                  onClick={() =>
                    onChange({
                      ...value,
                      folders: value.folders.filter(
                        (item) => item.path !== folder.path
                      ),
                    })
                  }
                >
                  <IconX className="size-3.5" />
                </button>
              </div>
            ))}
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              onClick={() => void addFolders()}
            >
              <IconFolderPlus className="size-4" />
              {t('projects.secureEnvironment.addFolder')}
            </Button>
          </div>

          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <label
                htmlFor="secure-environment-network"
                className="text-sm font-medium"
              >
                {t('projects.secureEnvironment.network')}
              </label>
              <p className="text-xs text-muted-foreground">
                {t('projects.secureEnvironment.networkDescription')}
              </p>
            </div>
            <Switch
              id="secure-environment-network"
              checked={value.network}
              onCheckedChange={(network) => onChange({ ...value, network })}
            />
          </div>

          {serverKeys.length > 0 && (
            <div className="space-y-1.5">
              <div className="space-y-1">
                <div className="text-sm font-medium">
                  {t('projects.secureEnvironment.connectors')}
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('projects.secureEnvironment.connectorsDescription')}
                </p>
              </div>
              {serverKeys.map((key) => {
                const config = mcpServers[key]
                const needsNetwork =
                  !value.network &&
                  Boolean(config) &&
                  isWebSearchServer(key, config)
                return (
                  <label
                    key={key}
                    className="flex cursor-pointer items-center gap-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      className="size-4 cursor-pointer accent-primary disabled:cursor-not-allowed"
                      checked={value.allowedMcpServers.includes(key)}
                      disabled={needsNetwork}
                      onChange={(event) =>
                        toggleServer(key, event.target.checked)
                      }
                    />
                    <span className="min-w-0 truncate">{key}</span>
                    {needsNetwork && (
                      <span className="text-xs text-muted-foreground">
                        {t('projects.secureEnvironment.needsNetwork')}
                      </span>
                    )}
                    {!config && (
                      <span className="text-xs text-muted-foreground">
                        {t('projects.secureEnvironment.serverRemoved')}
                      </span>
                    )}
                  </label>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}
