import { describe, expect, it } from 'vitest'
import { agentPathBasename, isAbsoluteAgentPath } from './agent-path'

describe('Agent paths', () => {
  it.each([
    'C:\\Users\\Misha\\report.txt',
    'D:/work/report.txt',
    '\\\\server\\share\\report.txt',
    '\\\\?\\C:\\Users\\Misha\\report.txt',
    '\\\\?\\UNC\\server\\share\\report.txt',
  ])('accepts Windows absolute path %s', (path) => {
    expect(isAbsoluteAgentPath(path)).toBe(true)
  })

  it.each([
    'folder\\report.txt',
    '\\folder\\report.txt',
    '\\\\.\\C:\\report.txt',
    '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\report.txt',
  ])('rejects unsafe or relative Windows path %s', (path) => {
    expect(isAbsoluteAgentPath(path)).toBe(false)
  })

  it('keeps Unix absolute-path support', () => {
    expect(isAbsoluteAgentPath('/tmp/report.txt')).toBe(true)
  })

  it('extracts a basename from either separator style', () => {
    expect(agentPathBasename('C:\\Users\\Misha\\report.txt')).toBe('report.txt')
    expect(agentPathBasename('/tmp/report.txt')).toBe('report.txt')
  })
})
