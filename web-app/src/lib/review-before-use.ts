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

/** Every permission id the review screen can show, for wording coverage. */
export const PERMISSION_IDS = [
  'markedDangerous',
  'unknownTool',
  'runCommands',
  'runScripts',
  'controlPrograms',
  'sendWebRequests',
  'changeFiles',
  'trashFiles',
  'changeClipboard',
  'showNotifications',
  'readFiles',
  'readGit',
  'seePrograms',
  'browseWeb',
  'searchDocuments',
  'transcribeMedia',
  'readClipboard',
  'lookAtImages',
  'instructionsOnly',
] as const

/** Every warning id the review screen can show, for wording coverage. */
export const WARNING_IDS = [
  'downloadAndRun',
  'deleteBroadly',
  'readSecrets',
  'sendData',
  'hideFromUser',
  'overrideInstructions',
  'encodedBlob',
  'unpinnedPackage',
  'unencrypted',
  'shellCommandLine',
] as const

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

export const COMMAND_MEANING_IDS = [
  'launcherNpm',
  'launcherPython',
  'launcherNode',
  'launcherPythonScript',
  'launcherDocker',
  'launcherShell',
  'launcherProgram',
  'autoYes',
  'packagePinned',
  'packageUnpinned',
  'shellRunsNext',
  'address',
  'path',
  'option',
  'value',
] as const

export type CommandMeaningId = (typeof COMMAND_MEANING_IDS)[number]

/** One part of a connector's command line and what it means. */
export type CommandPart = {
  text: string
  meaning: CommandMeaningId
  /** The fixed version, for a pinned package. */
  version?: string
}

export const CONNECTOR_ISSUE_IDS = [
  'runsAsYou',
  'downloadsCode',
  'shellRuns',
  'getsSecrets',
  'reachesPaths',
  'sendsToService',
] as const

export type ConnectorIssueId = (typeof CONNECTOR_ISSUE_IDS)[number]

/** Something that could go wrong, taken from the connector's settings. */
export type ConnectorIssue = {
  id: ConnectorIssueId
  params?: Record<string, string>
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
  /** Each part of a local connector's command, in plain words. */
  explanation: CommandPart[]
  /** What could go wrong, most basic first. */
  issues: ConnectorIssue[]
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

/** Launchers that download a package and run it. */
const PACKAGE_LAUNCHERS: Record<
  string,
  { meaning: CommandMeaningId; source: string }
> = {
  npx: { meaning: 'launcherNpm', source: 'npm' },
  bunx: { meaning: 'launcherNpm', source: 'npm' },
  pnpx: { meaning: 'launcherNpm', source: 'npm' },
  uvx: { meaning: 'launcherPython', source: 'PyPI' },
}

const OTHER_LAUNCHERS: Record<string, CommandMeaningId> = {
  node: 'launcherNode',
  python: 'launcherPythonScript',
  python3: 'launcherPythonScript',
  py: 'launcherPythonScript',
  docker: 'launcherDocker',
}

function packageVersion(program: string, pkg: string): string | null {
  if (program === 'uvx') {
    return pkg.match(/(?:==|@)(\d\S*)$/)?.[1] ?? null
  }
  const at = pkg.lastIndexOf('@')
  const version = at > 0 ? pkg.slice(at + 1) : ''
  return version && version !== 'latest' ? version : null
}

function looksLikePath(arg: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/|~(?:[\\/]|$)|\.{1,2}[\\/])/.test(arg)
}

function explainCommand(command: string, args: string[]): CommandPart[] {
  const program = programName(command)
  const packageLauncher = PACKAGE_LAUNCHERS[program]
  const isShell = SHELLS.has(program)
  const parts: CommandPart[] = [
    {
      text: command,
      meaning:
        packageLauncher?.meaning ??
        OTHER_LAUNCHERS[program] ??
        (isShell ? 'launcherShell' : 'launcherProgram'),
    },
  ]
  let packageSeen = !packageLauncher
  for (const arg of args) {
    const lower = arg.toLowerCase()
    if (!packageSeen && (lower === '-y' || lower === '--yes')) {
      parts.push({ text: arg, meaning: 'autoYes' })
    } else if (isShell && SHELL_COMMAND_FLAGS.has(lower)) {
      parts.push({ text: arg, meaning: 'shellRunsNext' })
    } else if (/^https?:\/\//i.test(arg)) {
      parts.push({ text: arg, meaning: 'address' })
    } else if (!packageSeen && !arg.startsWith('-')) {
      packageSeen = true
      const version = packageVersion(program, arg)
      parts.push(
        version
          ? { text: arg, meaning: 'packagePinned', version }
          : { text: arg, meaning: 'packageUnpinned' }
      )
    } else if (looksLikePath(arg)) {
      parts.push({ text: arg, meaning: 'path' })
    } else {
      parts.push({
        text: arg,
        meaning: arg.startsWith('-') ? 'option' : 'value',
      })
    }
  }
  return parts
}

export function describeConnector(config: ConnectorConfig): ConnectorSummary {
  const isWebsite =
    config.type === 'http' ||
    config.type === 'sse' ||
    (!!config.url && !config.command)

  if (isWebsite) {
    const warnings: ReviewWarning[] = []
    const address = config.url ?? ''
    let host = address
    try {
      const url = new URL(address)
      host = url.hostname
      if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)) {
        warnings.push({ id: 'unencrypted', evidence: address })
      }
    } catch {
      // An address that does not parse is reported as-is; starting it fails anyway.
    }
    const secretNames = [
      ...Object.keys(config.headers ?? {}),
      ...Object.keys(config.env ?? {}),
    ]
    const issues: ConnectorIssue[] = [
      { id: 'sendsToService', params: { host } },
    ]
    if (secretNames.length > 0) {
      issues.push({
        id: 'getsSecrets',
        params: { names: secretNames.join(', ') },
      })
    }
    return {
      kind: 'website',
      address,
      secretNames,
      warnings,
      explanation: [],
      issues,
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

  const program = programName(config.command)
  const explanation = explainCommand(config.command, args)
  const secretNames = Object.keys(config.env ?? {})
  const issues: ConnectorIssue[] = [{ id: 'runsAsYou' }]
  const source =
    PACKAGE_LAUNCHERS[program]?.source ??
    (program === 'docker' ? 'Docker' : undefined)
  if (source) issues.push({ id: 'downloadsCode', params: { source } })
  if (SHELLS.has(program)) issues.push({ id: 'shellRuns' })
  if (secretNames.length > 0) {
    issues.push({
      id: 'getsSecrets',
      params: { names: secretNames.join(', ') },
    })
  }
  const paths = explanation
    .filter((part) => part.meaning === 'path')
    .map((part) => part.text)
  if (paths.length > 0) {
    issues.push({ id: 'reachesPaths', params: { paths: paths.join(', ') } })
  }

  return {
    kind: 'program',
    runs,
    secretNames,
    warnings,
    explanation,
    issues,
  }
}

export const TOOL_LABEL_IDS = [
  'saysReadOnly',
  'saysMayDelete',
  'saysReachesOutside',
] as const

export type ToolLabelId = (typeof TOOL_LABEL_IDS)[number]

export const TOOL_HINT_IDS = [
  'deletes',
  'changes',
  'sends',
  'runsCode',
  'money',
  'visitsWeb',
] as const

export type ToolHintId = (typeof TOOL_HINT_IDS)[number]

/** A connector tool as its connector lists it. */
export type DescribableTool = {
  name: string
  description?: string
  readOnly?: boolean
  destructive?: boolean
  openWorld?: boolean
  inputSchema?: Record<string, unknown>
}

export type ToolInput = {
  name: string
  type?: string
  description?: string
  required: boolean
}

export type ToolDetail = {
  inputs: ToolInput[]
  /** What the tool says about itself. */
  labels: ToolLabelId[]
  /** Clues from its name and description - not proof. */
  hints: ToolHintId[]
}

const TOOL_HINT_RULES: Record<ToolHintId, RegExp> = {
  deletes:
    /\b(delete|deletes|deleting|remove|removes|removing|destroy|destroys|drop|purge|erase|wipe)\b/i,
  changes:
    /\b(write|writes|writing|create|creates|creating|update|updates|edit|edits|modify|modifies|insert|upload|uploads|save|saves|rename|move|moves)\b/i,
  sends:
    /\b(send|sends|post|posts|email|emails|mail|message|messages|publish|publishes|notify|reply|comment)\b/i,
  runsCode:
    /\b(exec|execute|executes|run|runs|shell|command|commands|eval|script|scripts|spawn|terminal)\b/i,
  money:
    /\b(pay|payment|payments|charge|charges|refund|refunds|invoice|invoices|transfer|transfers|purchase|checkout|subscription|billing)\b/i,
  visitsWeb:
    /\b(scrape|scrapes|scraping|crawl|crawls|fetch|fetches|browse|url|urls|webpage|webpages|website|websites|web|internet|download|downloads)\b/i,
}

export function describeTool(tool: DescribableTool): ToolDetail {
  const schema = tool.inputSchema ?? {}
  const properties =
    schema.properties && typeof schema.properties === 'object'
      ? (schema.properties as Record<string, Record<string, unknown>>)
      : {}
  const required = Array.isArray(schema.required)
    ? (schema.required as unknown[])
    : []
  const inputs = Object.entries(properties).map(([name, property]) => {
    const input: ToolInput = { name, required: required.includes(name) }
    const type = Array.isArray(property?.type)
      ? property.type.join(' or ')
      : property?.type
    if (typeof type === 'string') input.type = type
    if (typeof property?.description === 'string') {
      input.description = property.description
    }
    return input
  })

  const labels: ToolLabelId[] = []
  if (tool.readOnly === true) labels.push('saysReadOnly')
  else if (tool.destructive === true) labels.push('saysMayDelete')
  if (tool.openWorld === true) labels.push('saysReachesOutside')

  const words = `${tool.name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')} ${tool.description ?? ''}`
  const hints = TOOL_HINT_IDS.filter((id) => TOOL_HINT_RULES[id].test(words))

  return { inputs, labels, hints }
}
