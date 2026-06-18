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
