/**
 * The facts a "review before use" screen is built from (Task 28, decision D36):
 * what a skill or MCP connector can do, in plain terms, and warnings about
 * suspicious text. Everything here is derived from what the skill or connector
 * declares, never guessed by a model - a model reading an untrusted skill could
 * be misled by it.
 *
 * Results are ids, not sentences, so the screen can show them in the user's
 * language. Warnings carry the exact text that raised them. A clean result does
 * not prove anything is safe; it only means none of these patterns matched.
 */

export type PermissionLevel = 'risky' | 'changes' | 'reads'

export type PermissionId =
  | 'markedDangerous'
  | 'unknownTool'
  | 'runCommands'
  | 'runScripts'
  | 'controlPrograms'
  | 'sendWebRequests'
  | 'changeFiles'
  | 'trashFiles'
  | 'changeClipboard'
  | 'showNotifications'
  | 'readFiles'
  | 'readGit'
  | 'seePrograms'
  | 'browseWeb'
  | 'searchDocuments'
  | 'transcribeMedia'
  | 'readClipboard'
  | 'lookAtImages'
  | 'instructionsOnly'

export type Permission = {
  id: PermissionId
  level: PermissionLevel
  /** The agent tool ids this entry stands for, in the order they were declared. */
  tools: string[]
}

export type WarningId =
  | 'downloadAndRun'
  | 'deleteBroadly'
  | 'readSecrets'
  | 'sendData'
  | 'hideFromUser'
  | 'overrideInstructions'
  | 'encodedBlob'
  | 'unpinnedPackage'
  | 'unencrypted'
  | 'shellCommandLine'

export type ReviewWarning = {
  id: WarningId
  /** The text that raised the warning, so the user can judge it themselves. */
  evidence: string
}

const LEVEL_RANK: Record<PermissionLevel, number> = {
  risky: 0,
  changes: 1,
  reads: 2,
}

/** Agent tool id -> what it lets the AI do. Internal tools map to null. */
const TOOL_PERMISSIONS: Record<string, [PermissionId, PermissionLevel] | null> =
  {
    'os.shell.run': ['runCommands', 'risky'],
    'skill.run_script': ['runScripts', 'risky'],
    'os.proc.spawn': ['controlPrograms', 'risky'],
    'os.proc.kill': ['controlPrograms', 'risky'],
    'os.proc.write': ['controlPrograms', 'risky'],
    'os.proc.stop': ['controlPrograms', 'risky'],
    'os.http.request': ['sendWebRequests', 'risky'],
    'os.fs.write': ['changeFiles', 'changes'],
    'os.fs.mkdir': ['changeFiles', 'changes'],
    'os.fs.edit': ['changeFiles', 'changes'],
    'os.fs.patch': ['changeFiles', 'changes'],
    'os.fs.archive.extract': ['changeFiles', 'changes'],
    'os.fs.trash': ['trashFiles', 'changes'],
    'os.clipboard.write': ['changeClipboard', 'changes'],
    'os.notify': ['showNotifications', 'changes'],
    'os.fs.read': ['readFiles', 'reads'],
    'os.fs.read_document': ['readFiles', 'reads'],
    'os.fs.list': ['readFiles', 'reads'],
    'os.fs.glob': ['readFiles', 'reads'],
    'os.fs.grep': ['readFiles', 'reads'],
    'os.fs.hash': ['readFiles', 'reads'],
    'os.fs.diff': ['readFiles', 'reads'],
    'os.fs.archive.list': ['readFiles', 'reads'],
    'os.fs.archive.read_entry': ['readFiles', 'reads'],
    'os.code.symbols': ['readFiles', 'reads'],
    'os.code.find': ['readFiles', 'reads'],
    'os.code.refs': ['readFiles', 'reads'],
    'os.git.status': ['readGit', 'reads'],
    'os.git.log': ['readGit', 'reads'],
    'os.git.diff': ['readGit', 'reads'],
    'os.git.show': ['readGit', 'reads'],
    'os.git.blame': ['readGit', 'reads'],
    'os.git.branch': ['readGit', 'reads'],
    'os.proc.list': ['seePrograms', 'reads'],
    'os.proc.read': ['seePrograms', 'reads'],
    'os.web.search': ['browseWeb', 'reads'],
    'os.web.fetch': ['browseWeb', 'reads'],
    'docs.list': ['searchDocuments', 'reads'],
    'docs.retrieve': ['searchDocuments', 'reads'],
    'docs.chunks': ['searchDocuments', 'reads'],
    'os.media.transcribe': ['transcribeMedia', 'reads'],
    'os.media.youtube': ['transcribeMedia', 'reads'],
    'os.clipboard.read': ['readClipboard', 'reads'],
    'vision.describe': ['lookAtImages', 'reads'],
    'tool.view': null,
    'skill.view': null,
    'reply': null,
    'finish': null,
  }

export function describeSkillPermissions(skill: {
  requiresTools: string[]
  requiresScripts: string[]
  dangerous: boolean
}): Permission[] {
  const byId = new Map<PermissionId, Permission>()
  const add = (id: PermissionId, level: PermissionLevel, tool?: string) => {
    const existing = byId.get(id)
    if (existing) {
      if (tool && !existing.tools.includes(tool)) existing.tools.push(tool)
      return
    }
    byId.set(id, { id, level, tools: tool ? [tool] : [] })
  }

  if (skill.dangerous) add('markedDangerous', 'risky')
  for (const tool of skill.requiresTools) {
    if (!(tool in TOOL_PERMISSIONS)) {
      add('unknownTool', 'risky', tool)
      continue
    }
    const mapped = TOOL_PERMISSIONS[tool]
    if (mapped) add(mapped[0], mapped[1], tool)
  }
  if (skill.requiresScripts.length > 0) add('runScripts', 'risky')

  const permissions = [...byId.values()]
  if (permissions.length === 0) {
    return [{ id: 'instructionsOnly', level: 'reads', tools: [] }]
  }
  // Risky first, then changes, then reads; declared order within each. The
  // author's own "dangerous" flag always leads.
  const rank = (permission: Permission) =>
    permission.id === 'markedDangerous' ? -1 : LEVEL_RANK[permission.level]
  return permissions
    .map((permission, index) => ({ permission, index }))
    .sort(
      (a, b) => rank(a.permission) - rank(b.permission) || a.index - b.index
    )
    .map(({ permission }) => permission)
}

const TEXT_RULES: { id: WarningId; patterns: RegExp[] }[] = [
  {
    id: 'downloadAndRun',
    patterns: [
      /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/i,
      /\b(?:iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n|]*\|\s*(?:iex|invoke-expression)\b/i,
      /-enc(?:odedcommand)?\s+[A-Za-z0-9+/=]{8,}/i,
    ],
  },
  {
    id: 'deleteBroadly',
    patterns: [
      /\brm\s+-(?:rf|fr)\s+(?:~|\/(?:\s|\*|$)|\$HOME\b)/i,
      /\bRemove-Item\b[^\n]*-Recurse[^\n]*(?:\$env:USERPROFILE|\$HOME\b|~|\b[A-Z]:\\(?:\s|$))/i,
      /\b(?:del|erase|rmdir|rd)\s+\/s\b/i,
      /\bformat\s+[a-z]:/i,
    ],
  },
  {
    id: 'readSecrets',
    patterns: [
      /(?:\.ssh[/\\]|\bid_(?:rsa|ed25519|ecdsa)\b|\.aws[/\\]credentials|\.git-credentials|\.npmrc\b|\bwallet\.dat\b|\blogins\.json\b|\bLogin Data\b|\bcookies\.sqlite\b|\.kube[/\\]config)/i,
    ],
  },
  {
    id: 'sendData',
    patterns: [
      /\b(?:curl|wget)\b[^\n]*\s(?:-d|--data(?:-binary|-raw|-urlencode)?|-F|--form|-T|--upload-file|--post-file)\b/i,
      /\b(?:iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n]*\s-(?:Body|InFile)\b/i,
    ],
  },
  {
    id: 'hideFromUser',
    patterns: [
      /\b(?:do not|don't|never)\s+(?:tell|show|inform|notify|mention|alert)\s+(?:the\s+)?user\b/i,
      /\bwithout\s+(?:telling|asking|informing|notifying)\s+the\s+user\b/i,
      /\b(?:hide|conceal)\s+(?:this|these|it|them|the\s+\w+)\s+from\s+the\s+user\b/i,
    ],
  },
  {
    id: 'overrideInstructions',
    patterns: [
      /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|earlier|system)\s+(?:instructions|rules|prompts?)\b/i,
    ],
  },
  {
    id: 'encodedBlob',
    patterns: [/[A-Za-z0-9+/]{160,}={0,2}/],
  },
]

const MAX_EVIDENCE = 200

function evidenceFor(text: string, index: number, matched: string): string {
  if (matched.length > MAX_EVIDENCE) return `${matched.slice(0, 80)}…`
  const start = text.lastIndexOf('\n', index) + 1
  const endAt = text.indexOf('\n', index)
  const line = text.slice(start, endAt === -1 ? text.length : endAt).trim()
  return line.length > MAX_EVIDENCE ? `${line.slice(0, MAX_EVIDENCE)}…` : line
}

/** Suspicious patterns in skill instructions, scripts or a connector's command line. */
export function scanForWarnings(text: string): ReviewWarning[] {
  const warnings: ReviewWarning[] = []
  for (const rule of TEXT_RULES) {
    for (const pattern of rule.patterns) {
      const match = pattern.exec(text)
      if (match) {
        warnings.push({
          id: rule.id,
          evidence: evidenceFor(text, match.index, match[0]),
        })
        break
      }
    }
  }
  return warnings
}

export type ConnectorConfig = {
  command: string
  args: string[]
  env: Record<string, string>
  type?: 'stdio' | 'http' | 'sse'
  url?: string
  headers?: Record<string, string>
}

export type ConnectorSummary = {
  kind: 'program' | 'website'
  /** The command line a local connector runs. */
  runs?: string
  /** The address a web connector talks to. */
  address?: string
  /** Names only - never the values - of the secrets it is given. */
  secretNames: string[]
  warnings: ReviewWarning[]
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
const SHELLS = new Set(['powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh'])
const SHELL_COMMAND_FLAGS = new Set(['-c', '/c', '-command', '-encodedcommand'])

function programName(command: string): string {
  const base = command.split(/[/\\]/).pop() ?? command
  return base.toLowerCase().replace(/\.(?:cmd|exe|bat|ps1)$/, '')
}

function unpinnedPackage(command: string, args: string[]): string | null {
  const program = programName(command)
  let rest = args
  if (program === 'pnpm' || program === 'yarn') {
    if (args[0] !== 'dlx') return null
    rest = args.slice(1)
  } else if (program === 'pipx') {
    if (args[0] !== 'run') return null
    rest = args.slice(1)
  } else if (!['npx', 'bunx', 'pnpx', 'uvx'].includes(program)) {
    return null
  }
  const pkg = rest.find((arg) => !arg.startsWith('-'))
  if (!pkg) return null
  if (program === 'uvx' || program === 'pipx') {
    return /==|@\d/.test(pkg) ? null : pkg
  }
  const at = pkg.lastIndexOf('@')
  const version = at > 0 ? pkg.slice(at + 1) : ''
  return version && version !== 'latest' ? null : pkg
}

export function describeConnector(config: ConnectorConfig): ConnectorSummary {
  const isWebsite =
    config.type === 'http' ||
    config.type === 'sse' ||
    (!!config.url && !config.command)

  if (isWebsite) {
    const warnings: ReviewWarning[] = []
    const address = config.url ?? ''
    try {
      const url = new URL(address)
      if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)) {
        warnings.push({ id: 'unencrypted', evidence: address })
      }
    } catch {
      // An address that does not parse is reported as-is; starting it fails anyway.
    }
    return {
      kind: 'website',
      address,
      secretNames: [
        ...Object.keys(config.headers ?? {}),
        ...Object.keys(config.env ?? {}),
      ],
      warnings,
    }
  }

  const args = config.args ?? []
  const runs = [config.command, ...args].join(' ').trim()
  const warnings: ReviewWarning[] = []
  const pkg = unpinnedPackage(config.command, args)
  if (pkg) warnings.push({ id: 'unpinnedPackage', evidence: pkg })
  if (
    SHELLS.has(programName(config.command)) &&
    args.some((arg) => SHELL_COMMAND_FLAGS.has(arg.toLowerCase()))
  ) {
    warnings.push({ id: 'shellCommandLine', evidence: runs })
  }
  for (const warning of scanForWarnings(runs)) {
    if (!warnings.some((existing) => existing.id === warning.id))
      warnings.push(warning)
  }
  return {
    kind: 'program',
    runs,
    secretNames: Object.keys(config.env ?? {}),
    warnings,
  }
}
