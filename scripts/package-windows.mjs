import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

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
execFileSync(process.execPath, [pnpm, 'exec', 'electron-builder', '--win', '--x64', `--config.directories.output=${output}`], {
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
const distributableArtifacts = artifacts.filter((artifact) => (
  artifact.endsWith('.zip')
  || artifact.endsWith('.exe')
  || artifact.endsWith('.yml')
  || artifact.endsWith('.blockmap')
))
for (const artifact of distributableArtifacts) {
  await cp(join(output, artifact), join(release, artifact), {
    force: true
  })
}
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const updateArtifact = artifacts.find((artifact) => artifact.endsWith('.exe')) ?? zip
const updateArtifactPath = join(output, updateArtifact)
const updateArtifactBuffer = await readFile(updateArtifactPath)
const updateArtifactStat = await stat(updateArtifactPath)
await writeFile(join(release, 'release-info.json'), JSON.stringify({
  appKey: 'codexio',
  platform: 'electron',
  version: packageJson.version,
  fileName: updateArtifact,
  fileSizeBytes: updateArtifactStat.size,
  sha256: createHash('sha256').update(updateArtifactBuffer).digest('hex'),
  sha512: createHash('sha512').update(updateArtifactBuffer).digest('base64'),
  mimeType: updateArtifact.endsWith('.exe') ? 'application/vnd.microsoft.portable-executable' : 'application/zip'
}, null, 2))
