import { existsSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { Configer } from '../../Configer.js'
import { CodexioMetadata } from '../../CodexioMetadata.js'
import { ThreadWorkspaceResolver } from '../../ThreadWorkspaceResolver.js'

const bundledCodexRelativePath = join('resources', 'app.asar.unpacked', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe')
const require = createRequire(import.meta.url)

export type CodexRuntimeConfig = {
  bundled: boolean
  command: string
  args: string[]
  processCwd: string
  codexHomePath?: string
  proxyUrl?: string
  noProxyHosts: string[]
  instruction: string
  requestTimeoutMs: number
  observe?: {
    intervalMs: number
  }
}

type CodexCommand = {
  command: string
  args: string[]
}

export class CodexRuntimeResolver {
  constructor(
    private readonly configer: Configer,
    private readonly metadata: CodexioMetadata,
    private readonly workspaceResolver: ThreadWorkspaceResolver
  ) {}

  async resolve(): Promise<CodexRuntimeConfig> {
    const [
      bundled,
      proxyEnabled,
      proxyHost,
      proxyPort,
      proxyNoProxy,
      serverHost,
      codexCommand,
      instruction,
      requestTimeoutSeconds,
      observe
    ] = await Promise.all([
      this.configer.get('agents.codex.bundled'),
      this.configer.get('proxy.enabled'),
      this.configer.get('proxy.host'),
      this.configer.get('proxy.port'),
      this.configer.get('proxy.noProxy'),
      this.configer.get('server.host'),
      this.configer.get('agents.codex.command'),
      this.configer.get('agents.instruction'),
      this.configer.get('agents.codex.requestTimeoutSeconds'),
      this.configer.get('agents.codex.observe')
    ])
    const command = bundled
      ? bundledCodexCommand()
      : externalCodexCommand(codexCommand, this.metadata.rootPath)
    const cwd = await this.workspaceResolver.resolveBase()
    return {
      bundled,
      command: command.command,
      args: command.args,
      processCwd: cwd.length > 0 ? cwd : join(this.metadata.dataPath, 'workspace'),
      codexHomePath: bundled ? this.metadata.codexHomePath : undefined,
      proxyUrl: proxyEnabled ? `http://${proxyHost}:${proxyPort}` : undefined,
      noProxyHosts: [
        'localhost',
        '127.0.0.1',
        '::1',
        serverHost,
        ...proxyNoProxy.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
      ],
      instruction,
      requestTimeoutMs: requestTimeoutSeconds * 1000,
      observe: observe.enabled
          ? {
            intervalMs: observe.intervalSeconds * 1000
          }
        : undefined
    }
  }
}

function bundledCodexCommand(): CodexCommand {
  const packagedPath = join(dirname(process.execPath), bundledCodexRelativePath)
  if (existsSync(packagedPath)) {
    return {
      command: packagedPath,
      args: ['app-server']
    }
  }
  return {
    command: process.execPath,
    args: [
      require.resolve('@openai/codex/bin/codex.js'),
      'app-server'
    ]
  }
}

function externalCodexCommand(commandValue: string, rootPath: string): CodexCommand {
  return {
    command: resolveExternalCommand(commandValue.trim().length > 0 ? commandValue.trim() : 'codex', rootPath),
    args: ['app-server']
  }
}

function resolveExternalCommand(command: string, rootPath: string): string {
  if (!isBareCommand(command)) {
    return command
  }
  for (const directory of externalCommandDirectories(command, rootPath)) {
    for (const executableName of executableNames(command)) {
      const executablePath = join(directory, executableName)
      if (existsSync(executablePath)) {
        return executablePath
      }
    }
  }
  return command
}

function isBareCommand(command: string): boolean {
  return !isAbsolute(command) && !command.includes('/') && !command.includes('\\')
}

function executableNames(command: string): string[] {
  if (process.platform !== 'win32' || extname(command).length > 0) {
    return [command]
  }
  const extensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0)
  return [
    command,
    ...extensions.map((extension) => `${command}${extension}`)
  ]
}

function externalCommandDirectories(command: string, rootPath: string): string[] {
  const pathDirectories = (process.env.PATH ?? '')
    .split(delimiter)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  const localBinDirectories = new Set([
    join(rootPath, 'node_modules', '.bin'),
    resolve(rootPath, 'node_modules', '.bin'),
    join(dirname(process.execPath), 'resources', 'app.asar.unpacked', 'node_modules', '.bin'),
    resolve(dirname(process.execPath), 'resources', 'app.asar.unpacked', 'node_modules', '.bin')
  ].map((item) => process.platform === 'win32' ? item.toLowerCase() : item))
  const externalPathDirectories = pathDirectories.filter((item) => {
    const path = process.platform === 'win32' ? resolve(item).toLowerCase() : resolve(item)
    return !localBinDirectories.has(path)
  })
  if (!['codex', 'codex.exe'].includes(command.toLowerCase())) {
    return externalPathDirectories
  }
  return uniquePaths([
    ...vscodeCodexExtensionDirectories(),
    ...openaiCodexBinDirectories(),
    ...externalPathDirectories
  ])
}

function openaiCodexBinDirectories(): string[] {
  const root = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin') : ''
  if (!root || !existsSync(root)) {
    return []
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .sort((left, right) => modifiedTime(right) - modifiedTime(left))
}

function vscodeCodexExtensionDirectories(): string[] {
  const root = process.env.USERPROFILE ? join(process.env.USERPROFILE, '.vscode', 'extensions') : ''
  if (!root || !existsSync(root)) {
    return []
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().startsWith('openai.chatgpt-'))
    .map((entry) => join(root, entry.name, 'bin', 'windows-x86_64'))
    .sort((left, right) => modifiedTime(right) - modifiedTime(left))
}

function modifiedTime(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths))
}
