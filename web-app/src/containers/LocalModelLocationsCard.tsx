import { useCallback, useState } from 'react'
import { EngineManager } from '@janhq/core'
import { toast } from 'sonner'
import { IconFolderPlus, IconX, IconRefresh } from '@tabler/icons-react'
import { Card, CardItem } from '@/containers/Card'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { ModelSourceBadge } from '@/components/ModelSourceBadge'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { LOCAL_LLAMACPP_PROVIDER } from '@/lib/utils'
import { extractModelErrorMessage } from '@/lib/modelErrorMessage'
import {
  scanLocalModels,
  collectImportedModelPaths,
  type LocalModelCandidate,
} from '@/services/models/localScan'

function formatSize(bytes?: number): string | null {
  if (!bytes || bytes <= 0) return null
  const gb = bytes / 1024 ** 3
  if (gb >= 1) return `${gb.toFixed(2)} GB`
  const mb = bytes / 1024 ** 2
  return `${Math.max(1, Math.round(mb))} MB`
}

function formatLabel(format: LocalModelCandidate['format']): string {
  return format === 'mlx' ? 'MLX' : format === 'adapter' ? 'LoRA' : 'GGUF'
}

// Settings → "Detected model locations": toggle auto-scan, manage folders, scan + import.
export default function LocalModelLocationsCard() {
  const serviceHub = useServiceHub()
  const scanEnabled = useGeneralSetting((s) => s.scanLocalModels)
  const setScanEnabled = useGeneralSetting((s) => s.setScanLocalModels)
  const folders = useGeneralSetting((s) => s.localScanFolders)
  const addFolder = useGeneralSetting((s) => s.addLocalScanFolder)
  const removeFolder = useGeneralSetting((s) => s.removeLocalScanFolder)
  const setProviders = useModelProvider((s) => s.setProviders)

  const [scanning, setScanning] = useState(false)
  const [scanned, setScanned] = useState(false)
  const [candidates, setCandidates] = useState<LocalModelCandidate[]>([])
  const [importingId, setImportingId] = useState<string | null>(null)

  const handleAddFolder = useCallback(async () => {
    try {
      const selected = await serviceHub.dialog().open({
        multiple: false,
        directory: true,
      })
      if (typeof selected === 'string' && selected.length > 0) {
        addFolder(selected)
      }
    } catch (error) {
      console.error('Failed to pick scan folder:', error)
    }
  }, [serviceHub, addFolder])

  const handleScan = useCallback(async () => {
    setScanning(true)
    try {
      // Manual scan always runs; the toggle only gates automatic scanning.
      const importedPaths = collectImportedModelPaths(
        useModelProvider.getState().providers
      )
      const found = await scanLocalModels({
        enabled: true,
        extraRoots: useGeneralSetting.getState().localScanFolders,
        importedPaths,
      })
      setCandidates(found)
      setScanned(true)
    } catch (error) {
      console.error('Local model scan failed:', error)
      toast.error('Scan failed', {
        description: extractModelErrorMessage(error),
      })
    } finally {
      setScanning(false)
    }
  }, [])

  const handleImport = useCallback(
    async (cand: LocalModelCandidate) => {
      if (!cand.runnable || importingId) return
      const providerName = cand.format === 'mlx' ? 'mlx' : LOCAL_LLAMACPP_PROVIDER
      const engine = EngineManager.instance().get(providerName)
      if (!engine) {
        toast.error('Import failed', {
          description: `Engine ${providerName} not available`,
        })
        return
      }
      setImportingId(cand.id)
      try {
        await engine.import(cand.id, {
          modelPath: cand.path,
          mmprojPath: cand.mmprojPath,
          source: cand.source,
        })
        // Refresh providers so the new model shows up with its badge.
        const fetched = await serviceHub.providers().getProviders()
        setProviders(fetched)
        setCandidates((prev) => prev.filter((c) => c.id !== cand.id))
        toast.success('Model imported', { description: cand.displayName })
      } catch (error) {
        toast.error('Import failed', {
          description: extractModelErrorMessage(error),
        })
      } finally {
        setImportingId(null)
      }
    },
    [importingId, serviceHub, setProviders]
  )

  return (
    <Card title="Detected model locations">
      <CardItem
        title="Scan for local models"
        description="Find models already downloaded by Ollama, LM Studio, the Hugging Face cache, or Unsloth, and import them without re-downloading."
        actions={
          <Switch checked={scanEnabled} onCheckedChange={setScanEnabled} />
        }
      />

      <CardItem
        title="Scan folders"
        align="start"
        column
        description="Add extra folders to search for GGUF or MLX models. Default app locations are always checked."
        actions={
          <div className="mt-3 flex w-full flex-col gap-2">
            {folders.length > 0 && (
              <div className="flex flex-col gap-1.5">
                {folders.map((folder) => (
                  <div
                    key={folder}
                    className="flex items-center justify-between gap-2 rounded-md bg-secondary px-2 py-1.5"
                  >
                    <span
                      className="truncate text-xs text-foreground"
                      title={folder}
                    >
                      {folder}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeFolder(folder)}
                      className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
                      title="Remove folder"
                    >
                      <IconX size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={handleAddFolder}>
                <IconFolderPlus size={14} className="text-muted-foreground" />
                <span>Add folder</span>
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleScan}
                disabled={scanning}
              >
                <IconRefresh
                  size={14}
                  className={scanning ? 'animate-spin' : ''}
                />
                <span>{scanning ? 'Scanning…' : 'Scan now'}</span>
              </Button>
            </div>
          </div>
        }
      />

      {scanned && (
        <CardItem
          title={
            candidates.length > 0
              ? `Found ${candidates.length} model${candidates.length === 1 ? '' : 's'}`
              : 'No new local models found'
          }
          align="start"
          column
          description={
            candidates.length === 0
              ? 'Everything detected is already imported, or no compatible models were found.'
              : undefined
          }
          actions={
            candidates.length > 0 ? (
              <div className="mt-3 flex w-full flex-col divide-y divide-border/50">
                {candidates.map((cand) => {
                  const size = formatSize(cand.sizeBytes)
                  const isImporting = importingId === cand.id
                  return (
                    <div
                      key={cand.id}
                      className="flex items-center gap-3 py-2.5 first:pt-0"
                    >
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className="truncate text-sm font-medium text-foreground"
                            title={cand.path}
                          >
                            {cand.displayName}
                          </span>
                          <ModelSourceBadge
                            source={cand.source}
                            className="shrink-0"
                          />
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span className="rounded-[6px] border border-border bg-secondary px-1.5 py-0.5 text-[10px] font-extrabold uppercase leading-tight tracking-wider">
                            {formatLabel(cand.format)}
                          </span>
                          {size && <span>{size}</span>}
                          {!cand.runnable && <span>requires base model</span>}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant={cand.runnable ? 'default' : 'secondary'}
                        disabled={!cand.runnable || importingId !== null}
                        onClick={() => handleImport(cand)}
                        className="shrink-0"
                      >
                        {isImporting ? 'Importing…' : 'Import'}
                      </Button>
                    </div>
                  )
                })}
              </div>
            ) : undefined
          }
        />
      )}
    </Card>
  )
}
