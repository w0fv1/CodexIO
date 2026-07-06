import { existsSync } from 'node:fs'
import { cp, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export async function migrateLegacyDataRoot(
  legacyRoot: string,
  currentRoot: string,
  log: (message: string) => void = () => {}
): Promise<boolean> {
  const resolvedLegacyRoot = resolve(legacyRoot)
  const resolvedCurrentRoot = resolve(currentRoot)
  if (resolvedLegacyRoot === resolvedCurrentRoot) {
    return false
  }
  const legacyConfigPath = join(resolvedLegacyRoot, 'config.yaml')
  const currentConfigPath = join(resolvedCurrentRoot, 'config.yaml')
  if (!existsSync(legacyConfigPath) || existsSync(currentConfigPath)) {
    return false
  }
  await mkdir(resolvedCurrentRoot, {
    recursive: true
  })
  await cp(resolvedLegacyRoot, resolvedCurrentRoot, {
    recursive: true,
    force: false,
    errorOnExist: false
  })
  log(`migrated legacy data root from ${resolvedLegacyRoot} to ${resolvedCurrentRoot}`)
  return true
}
