export type WorkspacePreviewKind = 'image' | 'pdf' | 'text' | 'unsupported'

const IMAGE_EXTENSIONS = new Set(['gif', 'jpeg', 'jpg', 'png', 'webp'])
const TEXT_EXTENSIONS = new Set([
  'c',
  'cc',
  'conf',
  'cpp',
  'css',
  'csv',
  'env',
  'go',
  'h',
  'hpp',
  'html',
  'ini',
  'java',
  'js',
  'json',
  'jsonl',
  'jsx',
  'log',
  'md',
  'mjs',
  'py',
  'rb',
  'rs',
  'sh',
  'sql',
  'svg',
  'toml',
  'ts',
  'tsx',
  'txt',
  'xml',
  'yaml',
  'yml',
])

export function classifyWorkspacePreview(path: string): WorkspacePreviewKind {
  const extension = path.split('.').at(-1)?.toLowerCase()
  if (!extension || extension === path.toLowerCase()) {
    return 'unsupported'
  }
  if (IMAGE_EXTENSIONS.has(extension)) {
    return 'image'
  }
  if (extension === 'pdf') {
    return 'pdf'
  }
  if (TEXT_EXTENSIONS.has(extension)) {
    return 'text'
  }
  return 'unsupported'
}
