import { dirname, join, resolve } from 'node:path'
import { inject, injectable } from 'inversify'
import { CodexioConfig, ConfigSchema, createDefaultConfig, parseCodexioConfig, validateCodexioConfig } from '../value/ConfigDefinition.js'
import { CodexioMetadata } from './CodexioMetadata.js'
import { YamlFile } from './YamlFile.js'

export type ConfigChange = {
  paths: string[]
}

export type ConfigListener = (change: ConfigChange) => void | Promise<void>

export type SelectedConfigChange<T> = ConfigChange & {
  previousValue: T
  currentValue: T
}

export type SelectedConfigListener<T> = (change: SelectedConfigChange<T>) => void | Promise<void>

export type ConfigSubscription = {
  dispose: () => void
}

type ConfigObject = Record<string, unknown>
export type ConfigPatch<T> = {
  [K in keyof T]?: T[K] extends ConfigObject ? ConfigPatch<T[K]> : T[K]
}
type ConfigPath<T> = {
  [K in keyof T & string]: NonNullable<T[K]> extends ConfigObject ? K | `${K}.${ConfigPath<NonNullable<T[K]>>}` : K
}[keyof T & string]
type ConfigPathValue<T, P extends string> = P extends `${infer K}.${infer R}`
  ? K extends keyof T
    ? ConfigPathValue<NonNullable<T[K]>, R>
    : never
  : P extends keyof T
    ? T[P]
    : never

export type CodexioConfigPath = ConfigPath<CodexioConfig>
export type CodexioConfigPathValue<P extends CodexioConfigPath> = ConfigPathValue<CodexioConfig, P>

type ConfigListenerEntry = {
  listener: ConfigListener
}

type ConfigPathListenerEntry = {
  path: CodexioConfigPath
  listener: SelectedConfigListener<unknown>
}

type ConfigPathsListenerEntry = {
  paths: CodexioConfigPath[]
  listener: ConfigListener
}

type ConfigSubscriptionEntry = ConfigListenerEntry | ConfigPathListenerEntry | ConfigPathsListenerEntry

@injectable()
export class Configer {
  private readonly listeners = new Set<ConfigSubscriptionEntry>()
  readonly path: string

  constructor(@inject(CodexioMetadata) private readonly metadata: CodexioMetadata) {
    this.path = resolve(metadata.configPath)
  }

  async get<P extends CodexioConfigPath>(path: P): Promise<CodexioConfigPathValue<P>> {
    return getConfigPathValue(await this.load(), path)
  }

  async set<P extends CodexioConfigPath>(path: P, value: CodexioConfigPathValue<P>): Promise<ConfigChange> {
    return this.patch(createConfigPathPatch(path, value) as ConfigPatch<CodexioConfig>)
  }

  async validate(): Promise<void> {
    validateCodexioConfig(await this.load())
  }

  async init(force = false): Promise<CodexioConfig> {
    if (!force) {
      try {
        const config = await this.load()
        await this.write(config)
        return config
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }
    }
    const config = createDefaultConfig(join(dirname(this.path), 'workspace'))
    await this.write(config)
    return config
  }

  async exportText(): Promise<string> {
    return YamlFile.stringify(await this.load())
  }

  async importText(text: string): Promise<ConfigChange> {
    const previous = await this.load()
    const current = await parseCodexioConfig(YamlFile.parse(text), this.path)
    return this.saveChange(previous, current)
  }

  async patch(patch: ConfigPatch<CodexioConfig>): Promise<ConfigChange> {
    const previous = await this.load()
    const current = ConfigSchema.parse(deepMergeConfig(previous as unknown as ConfigObject, patch as unknown as ConfigObject))
    return this.saveChange(previous, current)
  }

  subscribe(listener: ConfigListener): ConfigSubscription
  subscribe<P extends CodexioConfigPath>(path: P, listener: SelectedConfigListener<CodexioConfigPathValue<P>>): ConfigSubscription
  subscribe(paths: CodexioConfigPath[], listener: ConfigListener): ConfigSubscription
  subscribe<P extends CodexioConfigPath>(listenerOrPath: ConfigListener | P | CodexioConfigPath[], selectedListener?: ConfigListener | SelectedConfigListener<CodexioConfigPathValue<P>>): ConfigSubscription {
    const entry: ConfigSubscriptionEntry = typeof listenerOrPath === 'string'
      ? {
          path: listenerOrPath,
          listener: selectedListener as SelectedConfigListener<unknown>
        }
      : Array.isArray(listenerOrPath)
        ? {
            paths: listenerOrPath,
            listener: selectedListener as ConfigListener
          }
        : {
            listener: listenerOrPath as ConfigListener
        }
    this.listeners.add(entry)
    return {
      dispose: () => {
        this.listeners.delete(entry)
      }
    }
  }

  private async saveChange(previous: CodexioConfig, current: CodexioConfig): Promise<ConfigChange> {
    const paths = diffConfigPaths(previous, current)
    await this.write(current)
    const change = {
      paths
    }
    if (paths.length > 0) {
      await this.notify(previous, current, change)
    }
    return change
  }

  private async load(): Promise<CodexioConfig> {
    const config = await parseCodexioConfig(await YamlFile.read(this.path), this.path)
    if (config.server.token.trim().length === 0) {
      config.server.token = createDefaultConfig(join(this.metadata.rootPath, '.codexio', 'workspace')).server.token
      await this.write(config)
    }
    return config
  }

  private async write(config: CodexioConfig): Promise<void> {
    await YamlFile.write(this.path, ConfigSchema.parse(config))
  }

  private async notify(previous: CodexioConfig, current: CodexioConfig, change: ConfigChange): Promise<void> {
    for (const entry of this.listeners) {
      if ('path' in entry) {
        if (!configPathChanged(change.paths, entry.path)) {
          continue
        }
        const previousValue = getConfigPathValue(previous, entry.path)
        const currentValue = getConfigPathValue(current, entry.path)
        if (deepEqual(previousValue, currentValue)) {
          continue
        }
        await entry.listener({
          ...change,
          previousValue,
          currentValue
        })
        continue
      }
      if ('paths' in entry) {
        if (!entry.paths.some((path) => configPathChanged(change.paths, path))) {
          continue
        }
        await entry.listener(change)
        continue
      }
      await entry.listener(change)
    }
  }
}

export function diffConfigPaths(previous: unknown, current: unknown): string[] {
  const paths: string[] = []
  collectDiffPaths(previous, current, '', paths)
  return paths
}

function getConfigPathValue<P extends CodexioConfigPath>(config: CodexioConfig, path: P): CodexioConfigPathValue<P> {
  const keys = path.split('.')
  let value: unknown = config
  for (const key of keys) {
    if (!isPlainObject(value)) {
      throw new Error(`config path not found: ${path}`)
    }
    value = value[key]
  }
  return value as CodexioConfigPathValue<P>
}

function createConfigPathPatch(path: string, value: unknown): ConfigObject {
  const keys = path.split('.')
  const root: ConfigObject = {}
  let current = root
  for (const key of keys.slice(0, -1)) {
    const next: ConfigObject = {}
    current[key] = next
    current = next
  }
  current[keys[keys.length - 1]] = value
  return root
}

function configPathChanged(changedPaths: string[], subscriptionPath: string): boolean {
  return changedPaths.some((path) => path === subscriptionPath || path.startsWith(`${subscriptionPath}.`) || subscriptionPath.startsWith(`${path}.`))
}

function collectDiffPaths(previous: unknown, current: unknown, path: string, paths: string[]): void {
  if (Object.is(previous, current)) {
    return
  }
  if (!isPlainObject(previous) || !isPlainObject(current)) {
    paths.push(path)
    return
  }
  const keys = new Set([
    ...Object.keys(previous),
    ...Object.keys(current)
  ])
  for (const key of keys) {
    collectDiffPaths(previous[key], current[key], path.length > 0 ? `${path}.${key}` : key, paths)
  }
}

function deepMergeConfig(left: ConfigObject, right: ConfigObject): ConfigObject {
  const merged: ConfigObject = {
    ...left
  }
  for (const [key, value] of Object.entries(right)) {
    if (value === undefined) {
      continue
    }
    const existing = merged[key]
    if (isPlainObject(existing) && isPlainObject(value)) {
      merged[key] = deepMergeConfig(existing, value)
      continue
    }
    merged[key] = value
  }
  return merged
}

function isPlainObject(value: unknown): value is ConfigObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false
    }
    return left.every((item, index) => deepEqual(item, right[index]))
  }
  if (!isPlainObject(left) || !isPlainObject(right)) {
    return false
  }
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) {
    return false
  }
  return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && deepEqual(left[key], right[key]))
}
