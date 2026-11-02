/** Stable auxiliary IDs select sources in conf; engine compatibility remains in the client. */
import { ATOMIC_COMMIT_RE, type AtomicCatalogEntry } from './catalogProtocol'
import { atomicModelCatalogBaseline, atomicModelCatalogSnapshot } from './modelCatalog'

export function atomicAuxiliaryModel(idOrRepo: string) {
  const catalog = atomicModelCatalogSnapshot()
  // Existing compatibility registries name a repository. Resolve that historical
  // name to its stable ID, so conf can move the source without changing clients.
  const id = catalog.models[idOrRepo]
    ? idOrRepo
    : catalog.models[`auxiliary:${idOrRepo}`]
      ? `auxiliary:${idOrRepo}`
      : Object.entries(atomicModelCatalogBaseline().models).find(
          ([, entry]) => entry.kind === 'auxiliary' && entry.definition.repo === idOrRepo
        )?.[0]
  const entry: AtomicCatalogEntry | undefined = id ? catalog.models[id] : undefined
  const source = entry?.definition
  if (
    entry?.kind !== 'auxiliary' ||
    typeof source?.repo !== 'string' ||
    typeof source.revision !== 'string' ||
    !ATOMIC_COMMIT_RE.test(source.revision) ||
    !Array.isArray(source.required) ||
    !Array.isArray(source.optional) ||
    ![...source.required, ...source.optional].every(
      (path) =>
        typeof path === 'string' &&
        path.split(/[\\/]/).every((part) => part && part !== '.' && part !== '..')
    )
  ) {
    throw new Error(`No valid auxiliary model source for ${idOrRepo}`)
  }
  return {
    entry,
    repo: source.repo,
    revision: source.revision,
    required: source.required as string[],
    optional: source.optional as string[],
  }
}

/** The variant ID stays stable when the filename, repo or version changes. */
export function atomicAuxiliaryFile(idOrRepo: string, variant: string) {
  const { entry, repo, revision } = atomicAuxiliaryModel(idOrRepo)
  const file = entry.variants[variant]
  if (
    !file ||
    typeof file.path !== 'string' ||
    file.path.split(/[\\/]/).some((part) => !part || part === '.' || part === '..') ||
    !Number.isSafeInteger(file.size) ||
    (file.size as number) < 0 ||
    (file.sha256 !== undefined &&
      (typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)))
  )
    throw new Error(`Invalid auxiliary variant ${variant}`)
  return {
    repo,
    revision,
    draftFilename: file.path,
    draftSize: file.size as number,
    draftSha256: typeof file.sha256 === 'string' ? file.sha256 : undefined,
    url: `https://huggingface.co/${repo}/resolve/${revision}/${file.path.split('/').map(encodeURIComponent).join('/')}`,
  }
}
