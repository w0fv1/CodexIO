import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { injectable } from 'inversify'
import { CodexioReleaseMetadata } from '../value/CodexioReleaseMetadata.js'

export type CodexioMetadataOptions = {
  rootPath?: string
  dataPath?: string
  configPath?: string
}

@injectable()
export class CodexioMetadata {
  readonly rootPath: string
  readonly dataPath: string
  readonly codexHomePath: string
  readonly configPath: string
  readonly logPath: string
  readonly filePath: string
  readonly serverStatePath: string
  readonly ioThreadStatePath: string

  constructor(options: CodexioMetadataOptions = {}) {
    this.rootPath = options.rootPath ?? (() => {
      let root = dirname(dirname(fileURLToPath(import.meta.url)))
      while (!existsSync(join(root, 'package.json')) && dirname(root) !== root) {
        root = dirname(root)
      }
      if (!existsSync(join(root, 'package.json'))) {
        throw new Error('codexio package root not found')
      }
      return root
    })()
    this.configPath = resolve(options.configPath ?? join(this.rootPath, '.codexio', 'config.yaml'))
    this.dataPath = resolve(options.dataPath ?? dirname(this.configPath))
    this.codexHomePath = join(this.dataPath, 'codex')
    this.logPath = join(this.dataPath, 'log')
    this.filePath = join(this.dataPath, 'file')
    this.serverStatePath = join(this.dataPath, 'state', 'server.json')
    this.ioThreadStatePath = join(this.dataPath, 'state', 'io-thread.json')
  }

  readVersion(): string {
    const text = readFileSync(join(this.rootPath, 'package.json'), 'utf8')
    const packageJson = JSON.parse(text) as {
      version?: unknown
    }
    if (typeof packageJson.version !== 'string' || packageJson.version.trim().length === 0) {
      throw new Error('package version is required')
    }
    return packageJson.version
  }

  readReleaseMetadata(): CodexioReleaseMetadata {
    const path = join(this.rootPath, '.codexio', 'release.json')
    if (!existsSync(path)) {
      return {}
    }
    const text = readFileSync(path, 'utf8')
    const metadata = JSON.parse(text) as {
      platform?: unknown
      version?: unknown
    }
    if (typeof metadata.platform !== 'string' || metadata.platform.trim().length === 0) {
      return {}
    }
    const release: CodexioReleaseMetadata = {
      platform: metadata.platform.trim()
    }
    if (typeof metadata.version === 'string' && metadata.version.trim().length > 0) {
      release.version = metadata.version.trim()
    }
    return release
  }
}
