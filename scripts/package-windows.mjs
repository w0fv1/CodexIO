import { cp, mkdir, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const pnpm = process.env.npm_execpath
if (!pnpm) {
  throw new Error('npm_execpath is required')
}
const buildId = `${Date.now()}-${process.pid}`
const output = join(root, '.tmp', 'package-windows', buildId)
const release = join(root, 'release-portable')

execFileSync(process.execPath, [pnpm, 'build'], {
  cwd: root,
  stdio: 'inherit'
})
execFileSync(process.execPath, [pnpm, 'exec', 'electron-builder', '--win', 'zip', '--x64', `--config.directories.output=${output}`], {
  cwd: root,
  stdio: 'inherit'
})

await mkdir(release, {
  recursive: true
})
const artifacts = await readdir(output)
const zip = artifacts.find((artifact) => artifact.endsWith('.zip'))
if (!zip) {
  throw new Error('Windows portable zip was not generated')
}
await cp(join(output, zip), join(release, zip), {
  force: true
})
