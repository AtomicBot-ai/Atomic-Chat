import type { ToolPresentation } from '../types'

type ActionLabel = {
  active: string
  completed: string
  failed: string
}

const ACTION_LABELS: Record<string, ActionLabel> = {
  'tool.view': {
    active: 'Loading tool details',
    completed: 'Loaded tool details',
    failed: 'Could not load tool details',
  },
  'os.shell.run': {
    active: 'Running command',
    completed: 'Ran command',
    failed: 'Command failed',
  },
  'os.fs.read': {
    active: 'Reading file',
    completed: 'Read file',
    failed: 'Could not read file',
  },
  'os.fs.write': {
    active: 'Writing file',
    completed: 'Wrote file',
    failed: 'Could not write file',
  },
  'os.fs.mkdir': {
    active: 'Creating folder',
    completed: 'Created folder',
    failed: 'Could not create folder',
  },
  'os.fs.trash': {
    active: 'Moving item to Trash',
    completed: 'Moved item to Trash',
    failed: 'Could not move item to Trash',
  },
  'os.fs.list': {
    active: 'Listing folder',
    completed: 'Listed folder',
    failed: 'Could not list folder',
  },
  'os.fs.glob': {
    active: 'Finding files',
    completed: 'Found matching files',
    failed: 'Could not find files',
  },
  'os.fs.grep': {
    active: 'Searching files',
    completed: 'Searched files',
    failed: 'Could not search files',
  },
  'os.fs.edit': {
    active: 'Editing file',
    completed: 'Edited file',
    failed: 'Could not edit file',
  },
  'os.fs.read_document': {
    active: 'Reading document',
    completed: 'Read document',
    failed: 'Could not read document',
  },
  'os.fs.archive.list': {
    active: 'Inspecting archive',
    completed: 'Inspected archive',
    failed: 'Could not inspect archive',
  },
  'os.fs.archive.read_entry': {
    active: 'Reading archive entry',
    completed: 'Read archive entry',
    failed: 'Could not read archive entry',
  },
  'os.fs.archive.extract': {
    active: 'Extracting archive',
    completed: 'Extracted archive',
    failed: 'Could not extract archive',
  },
  'os.fs.hash': {
    active: 'Calculating file hash',
    completed: 'Calculated file hash',
    failed: 'Could not calculate file hash',
  },
  'os.fs.diff': {
    active: 'Comparing files',
    completed: 'Compared files',
    failed: 'Could not compare files',
  },
  'os.fs.patch': {
    active: 'Applying patch',
    completed: 'Applied patch',
    failed: 'Could not apply patch',
  },
  'os.git.status': {
    active: 'Checking repository status',
    completed: 'Checked repository status',
    failed: 'Could not check repository status',
  },
  'os.git.log': {
    active: 'Reading commit history',
    completed: 'Read commit history',
    failed: 'Could not read commit history',
  },
  'os.git.diff': {
    active: 'Reviewing changes',
    completed: 'Reviewed changes',
    failed: 'Could not review changes',
  },
  'os.git.show': {
    active: 'Reading commit',
    completed: 'Read commit',
    failed: 'Could not read commit',
  },
  'os.git.blame': {
    active: 'Checking line history',
    completed: 'Checked line history',
    failed: 'Could not check line history',
  },
  'os.git.branch': {
    active: 'Checking branches',
    completed: 'Checked branches',
    failed: 'Could not check branches',
  },
  'os.proc.list': {
    active: 'Listing processes',
    completed: 'Listed processes',
    failed: 'Could not list processes',
  },
  'os.proc.kill': {
    active: 'Stopping process',
    completed: 'Stopped process',
    failed: 'Could not stop process',
  },
  'os.http.request': {
    active: 'Requesting URL',
    completed: 'Requested URL',
    failed: 'Request failed',
  },
  'os.web.search': {
    active: 'Searching the web',
    completed: 'Searched the web',
    failed: 'Web search failed',
  },
  'os.web.fetch': {
    active: 'Reading web page',
    completed: 'Read web page',
    failed: 'Could not read web page',
  },
  'os.clipboard.read': {
    active: 'Reading clipboard',
    completed: 'Read clipboard',
    failed: 'Could not read clipboard',
  },
  'os.clipboard.write': {
    active: 'Updating clipboard',
    completed: 'Updated clipboard',
    failed: 'Could not update clipboard',
  },
  'os.notify': {
    active: 'Sending notification',
    completed: 'Sent notification',
    failed: 'Could not send notification',
  },
}

function humanizeToolName(toolName: string): string {
  const name = toolName.split('.').at(-1) ?? toolName
  return name
    .replaceAll('_', ' ')
    .replaceAll('-', ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
}

function readSubtitle(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const values = input as Record<string, unknown>
  const value =
    values.path ??
    values.url ??
    values.query ??
    values.pattern ??
    values.name ??
    values.cmd
  return typeof value === 'string' && value.trim() ? value : undefined
}

export function presentGenericTool(args: {
  toolName: string
  input?: unknown
  output?: unknown
  errorText?: string
  state?: string
}): ToolPresentation {
  const isActive =
    args.state === 'input-streaming' || args.state === 'input-available'
  const hasError =
    args.state === 'output-error' || args.state === 'output-denied'
  const action = ACTION_LABELS[args.toolName]
  const fallbackName = humanizeToolName(args.toolName)

  return {
    kind: 'generic',
    title: action
      ? isActive
        ? action.active
        : hasError
          ? action.failed
          : action.completed
      : isActive
        ? `Calling ${fallbackName}`
        : hasError
          ? `${fallbackName} failed`
          : `Called ${fallbackName}`,
    subtitle: readSubtitle(args.input),
    input: args.input,
    output: args.output,
    errorText: args.errorText,
  }
}
