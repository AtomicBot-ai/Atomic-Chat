export type WorkspacePreviewKind =
  | 'image'
  | 'pdf'
  | 'text'
  | 'video'
  | 'audio'
  | 'unsupported'

const IMAGE_EXTENSIONS = new Set(['gif', 'jpeg', 'jpg', 'png', 'webp'])

// Only formats the webview can actually decode (WKWebView / WebView2 /
// WebKitGTK). Containers like .mkv or .avi stay "unsupported" so the panel
// says so up front instead of showing a dead player.
const VIDEO_MIME_TYPES: Record<string, string> = {
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  ogv: 'video/ogg',
  webm: 'video/webm',
}

const AUDIO_MIME_TYPES: Record<string, string> = {
  aac: 'audio/aac',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
}

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

function extensionOf(path: string): string | undefined {
  const extension = path.split('.').at(-1)?.toLowerCase()
  if (!extension || extension === path.toLowerCase()) return undefined
  return extension
}

export function classifyWorkspacePreview(path: string): WorkspacePreviewKind {
  const extension = extensionOf(path)
  if (!extension) {
    return 'unsupported'
  }
  if (IMAGE_EXTENSIONS.has(extension)) {
    return 'image'
  }
  if (extension === 'pdf') {
    return 'pdf'
  }
  if (extension in VIDEO_MIME_TYPES) {
    return 'video'
  }
  if (extension in AUDIO_MIME_TYPES) {
    return 'audio'
  }
  if (TEXT_EXTENSIONS.has(extension)) {
    return 'text'
  }
  return 'unsupported'
}

/**
 * Image or video kind of a remote URL, judged by the path's extension (query
 * string and fragment ignored). Undefined for anything the webview could not
 * show inline, including URLs without an extension.
 */
export function classifyMediaUrl(url: string): 'image' | 'video' | undefined {
  let path: string
  try {
    path = new URL(url).pathname
  } catch {
    return undefined
  }
  const kind = classifyWorkspacePreview(path)
  return kind === 'image' || kind === 'video' ? kind : undefined
}

/**
 * MIME type for a previewable audio/video file, so the media element can pick
 * a decoder without sniffing the asset URL. Undefined for every other kind.
 */
export function workspacePreviewMediaType(path: string): string | undefined {
  const extension = extensionOf(path)
  if (!extension) return undefined
  return VIDEO_MIME_TYPES[extension] ?? AUDIO_MIME_TYPES[extension]
}
