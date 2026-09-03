import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  IconChevronDown,
  IconCodeDots,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react'
import { MCPServerConfig, useMCPServers } from '@/hooks/useMCPServers'
import {
  isEnvAssignment,
  joinCommandLine,
  parseCommandLine,
} from '@/lib/command-line'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import CodeEditor from '@uiw/react-textarea-code-editor'
import '@uiw/react-textarea-code-editor/dist.css'

type KeyValueRow = { key: string; value: string }

const EMPTY_ROWS: KeyValueRow[] = [{ key: '', value: '' }]

const rowsFromRecord = (record?: Record<string, string>): KeyValueRow[] => {
  const rows = Object.entries(record ?? {}).map(([key, value]) => ({
    key,
    value,
  }))
  return rows.length > 0 ? rows : EMPTY_ROWS
}

const recordFromRows = (rows: KeyValueRow[]): Record<string, string> => {
  const record: Record<string, string> = {}
  rows.forEach(({ key, value }) => {
    const name = key.trim()
    if (name !== '') record[name] = value.trim()
  })
  return record
}

function KeyValueRows({
  label,
  rows,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
}: {
  label: string
  rows: KeyValueRow[]
  onChange: (rows: KeyValueRow[]) => void
  keyPlaceholder: string
  valuePlaceholder: string
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-sm">{label}</label>
        <div
          className="size-6 cursor-pointer flex items-center justify-center rounded hover:bg-secondary transition-all duration-200 ease-in-out"
          onClick={() => onChange([...rows, { key: '', value: '' }])}
        >
          <IconPlus size={16} className="text-muted-foreground" />
        </div>
      </div>
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            value={row.key}
            onChange={(e) =>
              onChange(
                rows.map((r, i) =>
                  i === index ? { ...r, key: e.target.value } : r
                )
              )
            }
            placeholder={keyPlaceholder}
            className="flex-1"
          />
          <Input
            value={row.value}
            onChange={(e) =>
              onChange(
                rows.map((r, i) =>
                  i === index ? { ...r, value: e.target.value } : r
                )
              )
            }
            placeholder={valuePlaceholder}
            className="flex-1"
          />
          {rows.length > 1 && (
            <div
              className="size-6 cursor-pointer flex items-center justify-center rounded hover:bg-secondary transition-all duration-200 ease-in-out"
              onClick={() => {
                const next = rows.filter((_, i) => i !== index)
                onChange(next.length > 0 ? next : EMPTY_ROWS)
              }}
            >
              <IconTrash size={16} className="text-destructive" />
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

interface AddEditMCPServerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  editingKey: string | null
  initialData?: MCPServerConfig
  onSave: (name: string, config: MCPServerConfig) => void
}

export default function AddEditMCPServer({
  open,
  onOpenChange,
  editingKey,
  initialData,
  onSave,
}: AddEditMCPServerProps) {
  const { t } = useTranslation()
  const getServerConfig = useMCPServers((state) => state.getServerConfig)

  const [serverName, setServerName] = useState('')
  const [connection, setConnection] = useState<'local' | 'remote'>('local')
  const [commandLine, setCommandLine] = useState('')
  const [url, setUrl] = useState('')
  const [transport, setTransport] = useState<'http' | 'sse'>('http')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [envRows, setEnvRows] = useState<KeyValueRow[]>(EMPTY_ROWS)
  const [headerRows, setHeaderRows] = useState<KeyValueRow[]>(EMPTY_ROWS)
  const [timeoutStr, setTimeoutStr] = useState('')
  const [cwd, setCwd] = useState('')
  const [isJsonMode, setIsJsonMode] = useState(false)
  const [jsonContent, setJsonContent] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Hydrate on open: edit mode joins command+args back into one line so the
  // round trip through parseCommandLine is lossless.
  useEffect(() => {
    if (open && editingKey && initialData) {
      const isRemote =
        initialData.type === 'http' ||
        initialData.type === 'sse' ||
        (!initialData.command && !!initialData.url)
      setServerName(editingKey)
      setConnection(isRemote ? 'remote' : 'local')
      setCommandLine(
        joinCommandLine(initialData.command || '', initialData.args || [])
      )
      setUrl(initialData.url || '')
      setTransport(initialData.type === 'sse' ? 'sse' : 'http')
      setEnvRows(rowsFromRecord(initialData.env))
      setHeaderRows(rowsFromRecord(initialData.headers))
      setTimeoutStr(initialData.timeout ? String(initialData.timeout) : '')
      setCwd(initialData.cwd || '')
      setAdvancedOpen(
        Object.keys(initialData.env ?? {}).length > 0 ||
          Object.keys(initialData.headers ?? {}).length > 0 ||
          initialData.timeout !== undefined ||
          !!initialData.cwd ||
          initialData.type === 'sse'
      )
      try {
        setJsonContent(JSON.stringify({ [editingKey]: initialData }, null, 2))
      } catch {
        setJsonContent('')
      }
      setIsJsonMode(false)
      setError(null)
    } else if (open) {
      resetForm()
    }
  }, [open, editingKey, initialData])

  const resetForm = () => {
    setServerName('')
    setConnection('local')
    setCommandLine('')
    setUrl('')
    setTransport('http')
    setAdvancedOpen(false)
    setEnvRows(EMPTY_ROWS)
    setHeaderRows(EMPTY_ROWS)
    setTimeoutStr('')
    setCwd('')
    setIsJsonMode(false)
    setJsonContent('')
    setError(null)
  }

  const clearError = () => setError(null)

  const handleSaveJsonMode = () => {
    try {
      const parsedData = JSON.parse(jsonContent)
      if (typeof parsedData !== 'object' || parsedData === null) {
        setError(t('mcp-servers:editJson.errorFormat'))
        return
      }
      // A bare config shape means the wrapping server-name key is missing.
      if (parsedData.command || parsedData.url) {
        setError(t('mcp-servers:editJson.errorMissingServerNameKey'))
        return
      }

      for (const [name, config] of Object.entries(parsedData)) {
        const trimmedName = name.trim()
        if (!trimmedName) {
          setError(t('mcp-servers:editJson.errorServerName'))
          return
        }
        const serverConfig = config as MCPServerConfig
        if (
          serverConfig.type &&
          !['stdio', 'http', 'sse'].includes(serverConfig.type)
        ) {
          setError(
            t('mcp-servers:editJson.errorInvalidType', {
              serverName: trimmedName,
              type: serverConfig.type,
            })
          )
          return
        }
        onSave(trimmedName, serverConfig)
      }
      onOpenChange(false)
      resetForm()
    } catch {
      setError(t('mcp-servers:editJson.errorFormat'))
    }
  }

  const handleSave = () => {
    if (isJsonMode) {
      handleSaveJsonMode()
      return
    }

    const name = serverName.trim()
    if (name === '') return

    // Duplicate names would silently overwrite another server's config.
    const isRename = editingKey !== null && editingKey !== name
    if ((editingKey === null || isRename) && getServerConfig(name)) {
      setError(t('mcp-servers:formErrors.nameExists', { name }))
      return
    }

    const timeoutValue = timeoutStr.trim() ? parseInt(timeoutStr, 10) : NaN
    const timeout =
      Number.isFinite(timeoutValue) && timeoutValue > 0
        ? timeoutValue
        : undefined

    let config: MCPServerConfig
    if (connection === 'local') {
      const parsed = parseCommandLine(commandLine)
      if (!parsed.ok) {
        setError(
          t(
            parsed.error === 'empty'
              ? 'mcp-servers:formErrors.commandRequired'
              : parsed.error === 'unterminated-quote'
                ? 'mcp-servers:formErrors.commandUnterminatedQuote'
                : 'mcp-servers:formErrors.commandTrailingBackslash'
          )
        )
        return
      }
      if (isEnvAssignment(parsed.command)) {
        setError(t('mcp-servers:formErrors.commandEnvPrefix'))
        return
      }
      config = {
        ...(initialData || {}),
        command: parsed.command,
        args: parsed.args,
        env: recordFromRows(envRows),
        type: 'stdio',
        cwd: cwd.trim() || undefined,
        timeout,
        url: undefined,
        headers: undefined,
      }
    } else {
      // The backend hard-errors on a URL without an explicit transport type,
      // so a remote server always saves type http (or the sse override).
      let parsedUrl = url.trim()
      try {
        new URL(parsedUrl)
      } catch {
        const withScheme = parsedUrl.includes('://')
          ? null
          : `https://${parsedUrl}`
        try {
          if (!withScheme) throw new Error('invalid')
          new URL(withScheme)
          parsedUrl = withScheme
        } catch {
          setError(t('mcp-servers:formErrors.urlInvalid'))
          return
        }
      }
      const headers = recordFromRows(headerRows)
      config = {
        ...(initialData || {}),
        command: '',
        args: [],
        env: {},
        type: transport,
        url: parsedUrl,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        timeout,
        cwd: undefined,
      }
    }

    onSave(name, config)
    onOpenChange(false)
    resetForm()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-2xl lg:max-w-2xl xl:max-w-2xl"
        showCloseButton={false}
        onInteractOutside={(e) => {
          e.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between">
            <span>
              {editingKey
                ? t('mcp-servers:editServer')
                : t('mcp-servers:addServer')}
            </span>
            <div
              className={cn(
                'size-6 cursor-pointer flex items-center justify-center rounded hover:bg-secondary transition-all duration-200 ease-in-out',
                isJsonMode && 'bg-secondary text-primary'
              )}
              title={t('mcp-servers:addServerByJson')}
              onClick={() => setIsJsonMode(!isJsonMode)}
            >
              <IconCodeDots className="h-5 w-5 cursor-pointer transition-colors duration-200" />
            </div>
          </DialogTitle>
        </DialogHeader>
        {isJsonMode ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm mb-2 inline-block">
                {t('mcp-servers:editJson.placeholder')}
              </label>
              <div className="border rounded-md overflow-hidden">
                <CodeEditor
                  value={jsonContent}
                  language="json"
                  placeholder={`{
  "serverName": {
    "command": "command",
    "args": ["arg1", "arg2"],
    "env": {
      "KEY": "value"
    }
  }
}`}
                  onChange={(e) => {
                    setJsonContent(e.target.value)
                    clearError()
                  }}
                  onPaste={clearError}
                  style={{
                    backgroundColor: 'transparent',
                    wordBreak: 'break-all',
                    overflowWrap: 'anywhere',
                    whiteSpace: 'pre-wrap',
                  }}
                  className="w-full text-sm! min-h-[300px] font-mono!"
                />
              </div>
              {error && <div className="text-destructive text-sm">{error}</div>}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm mb-2 inline-block">
                {t('mcp-servers:serverName')}
              </label>
              <Input
                value={serverName}
                onChange={(e) => {
                  setServerName(e.target.value)
                  clearError()
                }}
                placeholder={t('mcp-servers:enterServerName')}
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm mb-2 inline-block">
                {t('mcp-servers:connection')}
              </label>
              <div
                role="group"
                className="bg-muted flex w-full items-stretch gap-1 rounded-full p-1"
              >
                <Button
                  type="button"
                  variant="ghost"
                  aria-pressed={connection === 'local'}
                  className={cn(
                    'flex-1',
                    connection === 'local'
                      ? 'bg-background text-foreground shadow-xs hover:bg-background'
                      : 'text-muted-foreground hover:bg-transparent hover:text-foreground'
                  )}
                  onClick={() => {
                    setConnection('local')
                    clearError()
                  }}
                >
                  {t('mcp-servers:connectionLocal')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  aria-pressed={connection === 'remote'}
                  className={cn(
                    'flex-1',
                    connection === 'remote'
                      ? 'bg-background text-foreground shadow-xs hover:bg-background'
                      : 'text-muted-foreground hover:bg-transparent hover:text-foreground'
                  )}
                  onClick={() => {
                    setConnection('remote')
                    clearError()
                  }}
                >
                  {t('mcp-servers:connectionRemote')}
                </Button>
              </div>
            </div>

            {connection === 'local' ? (
              <div className="space-y-2">
                <label className="text-sm mb-2 inline-block">
                  {t('mcp-servers:command')}
                </label>
                <Input
                  value={commandLine}
                  onChange={(e) => {
                    setCommandLine(e.target.value)
                    clearError()
                  }}
                  placeholder={t('mcp-servers:commandLinePlaceholder')}
                  className="font-mono"
                />
              </div>
            ) : (
              <div className="space-y-2">
                <label className="text-sm mb-2 inline-block">
                  {t('mcp-servers:url')}
                </label>
                <Input
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value)
                    clearError()
                  }}
                  placeholder={t('mcp-servers:enterUrl')}
                />
              </div>
            )}

            <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <IconChevronDown
                    size={16}
                    className={cn(
                      'transition-transform',
                      !advancedOpen && '-rotate-90'
                    )}
                  />
                  {advancedOpen
                    ? t('mcp-servers:hideAdvanced')
                    : t('mcp-servers:showAdvanced')}
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-4 pt-3">
                {connection === 'local' ? (
                  <>
                    <KeyValueRows
                      label={t('mcp-servers:envVars')}
                      rows={envRows}
                      onChange={setEnvRows}
                      keyPlaceholder={t('mcp-servers:key')}
                      valuePlaceholder={t('mcp-servers:value')}
                    />
                    <div className="space-y-2">
                      <label className="text-sm mb-2 inline-block">
                        {t('mcp-servers:cwd')}
                      </label>
                      <Input
                        value={cwd}
                        onChange={(e) => setCwd(e.target.value)}
                        placeholder={t('mcp-servers:enterCwd')}
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <KeyValueRows
                      label={t('mcp-servers:headers')}
                      rows={headerRows}
                      onChange={setHeaderRows}
                      keyPlaceholder={t('mcp-servers:headerName')}
                      valuePlaceholder={t('mcp-servers:headerValue')}
                    />
                    <div className="space-y-2">
                      <label className="text-sm mb-2 inline-block">
                        {t('mcp-servers:transport')}
                      </label>
                      <select
                        value={transport}
                        onChange={(e) =>
                          setTransport(e.target.value as 'http' | 'sse')
                        }
                        className="w-full h-9 rounded-md border border-input bg-background px-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                      >
                        <option value="http">
                          {t('mcp-servers:transportHttp')}
                        </option>
                        <option value="sse">
                          {t('mcp-servers:transportSse')}
                        </option>
                      </select>
                    </div>
                  </>
                )}
                <div className="space-y-2">
                  <label className="text-sm mb-2 inline-block">
                    {t('mcp-servers:timeout')}
                  </label>
                  <Input
                    value={timeoutStr}
                    onChange={(e) => setTimeoutStr(e.target.value)}
                    placeholder={t('mcp-servers:enterTimeout')}
                    type="number"
                  />
                </div>
              </CollapsibleContent>
            </Collapsible>

            {error && <div className="text-destructive text-sm">{error}</div>}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t('common:cancel')}
          </Button>
          <Button
            onClick={handleSave}
            size="sm"
            disabled={!isJsonMode && serverName.trim() === ''}
          >
            {t('mcp-servers:save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
