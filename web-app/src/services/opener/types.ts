/**
 * Opener Service Types
 * Types for opening/revealing files and folders
 */

export interface OpenerService {
  open(target: string): Promise<void>
  revealItemInDir(path: string): Promise<void>
}
