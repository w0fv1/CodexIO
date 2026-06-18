import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const codexioRootPath = findCodexioRoot()

export function readCodexioVersion(): string {
  const text = readFileSync(join(codexioRootPath, 'package.json'), 'utf8')
  const packageJson = JSON.parse(text) as {
    version?: unknown
  }
  if (typeof packageJson.version !== 'string' || packageJson.version.trim().length === 0) {
    throw new Error('package version is required')
  }
  return packageJson.version
}

export type CodexioReleaseMetadata = {
  platform?: string
}

export function readCodexioReleaseMetadata(): CodexioReleaseMetadata {
  const path = join(codexioRootPath, '.codexio', 'release.json')
  if (!existsSync(path)) {
    return {}
  }
  const text = readFileSync(path, 'utf8')
  const metadata = JSON.parse(text) as {
    platform?: unknown
  }
  if (typeof metadata.platform !== 'string' || metadata.platform.trim().length === 0) {
    return {}
  }
  return {
    platform: metadata.platform.trim()
  }
}

function findCodexioRoot(): string {
  let root = dirname(fileURLToPath(import.meta.url))
  while (!existsSync(join(root, 'package.json')) && dirname(root) !== root) {
    root = dirname(root)
  }
  if (!existsSync(join(root, 'package.json'))) {
    throw new Error('codexio package root not found')
  }
  return root
}
