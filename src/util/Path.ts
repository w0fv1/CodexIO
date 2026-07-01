import { homedir } from 'node:os'
import { join } from 'node:path'

export function resolveUserPath(path: string): string {
  const normalized = path.trim()
  if (normalized === '~') {
    return homedir()
  }
  if (normalized.startsWith('~/') || normalized.startsWith('~\\')) {
    return join(homedir(), normalized.slice(2))
  }
  return normalized
}
