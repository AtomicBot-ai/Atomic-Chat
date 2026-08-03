const WINDOWS_DRIVE_ABSOLUTE = /^[a-zA-Z]:[\\/]/
const WINDOWS_UNC_ABSOLUTE = /^\\\\(?![?.]\\)[^\\/]+\\[^\\/]+(?:\\|$)/
const WINDOWS_VERBATIM_DRIVE = /^\\\\\?\\[a-zA-Z]:\\/
const WINDOWS_VERBATIM_UNC = /^\\\\\?\\UNC\\[^\\]+\\[^\\]+(?:\\|$)/i

export function isAbsoluteAgentPath(value: string): boolean {
  return (
    value.startsWith('/') ||
    WINDOWS_DRIVE_ABSOLUTE.test(value) ||
    WINDOWS_UNC_ABSOLUTE.test(value) ||
    WINDOWS_VERBATIM_DRIVE.test(value) ||
    WINDOWS_VERBATIM_UNC.test(value)
  )
}

export function agentPathBasename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}
