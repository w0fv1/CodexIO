import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { CodexioConfig, ConfigSchema, createDefaultConfig, defaultConfigPath, parseCodexioConfig } from './ConfigDefinition.js'
import { YamlFile } from '../component/YamlFile.js'

export type ConfigChange = {
  previous: CodexioConfig
  current: CodexioConfig
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

type ConfigListenerEntry = {
  listener: ConfigListener
}

type SelectedConfigListenerEntry<T> = {
  selector: (config: CodexioConfig) => T
  listener: SelectedConfigListener<T>
}

type ConfigSubscriptionEntry = ConfigListenerEntry | SelectedConfigListenerEntry<unknown>

export class Configer {
  private readonly listeners = new Set<ConfigSubscriptionEntry>()
  readonly path: string

  constructor(path = defaultConfigPath) {
    this.path = resolve(path)
  }

  async read(): Promise<CodexioConfig> {
    const config = await parseCodexioConfig(await YamlFile.read(this.path), this.path)
    if (config.server.token.trim().length === 0) {
      config.server.token = createDefaultConfig().server.token
      await this.write(config)
    }
    return config
  }

  async init(force = false): Promise<CodexioConfig> {
    if (!force) {
      try {
        const config = await this.read()
        await this.write(config)
        return config
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }
    }
    const config = createDefaultConfig()
    await mkdir(config.workspace.path, {
      recursive: true
    })
    await this.write(config)
    return config
  }

  async replace(next: CodexioConfig): Promise<ConfigChange> {
    const previous = await this.read()
    const current = ConfigSchema.parse(next)
    return this.saveChange(previous, current)
  }

  async exportText(): Promise<string> {
    return YamlFile.stringify(await this.read())
  }

  async importText(text: string): Promise<ConfigChange> {
    const previous = await this.read()
    const current = await parseCodexioConfig(YamlFile.parse(text), this.path)
    return this.saveChange(previous, current)
  }

  async patch(patch: Partial<CodexioConfig>): Promise<ConfigChange> {
    const previous = await this.read()
    const current = ConfigSchema.parse(deepMergeConfig(previous as unknown as ConfigObject, patch as unknown as ConfigObject))
    return this.saveChange(previous, current)
  }

  subscribe(listener: ConfigListener): ConfigSubscription
  subscribe<T>(selector: (config: CodexioConfig) => T, listener: SelectedConfigListener<T>): ConfigSubscription
  subscribe<T>(listenerOrSelector: ConfigListener | ((config: CodexioConfig) => T), selectedListener?: SelectedConfigListener<T>): ConfigSubscription {
    const entry: ConfigSubscriptionEntry = selectedListener
      ? {
          selector: listenerOrSelector as (config: CodexioConfig) => T,
          listener: selectedListener as SelectedConfigListener<unknown>
        }
      : {
          listener: listenerOrSelector as ConfigListener
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
      previous,
      current,
      paths
    }
    if (paths.length > 0) {
      await this.notify(change)
    }
    return change
  }

  private async write(config: CodexioConfig): Promise<void> {
    await YamlFile.write(this.path, ConfigSchema.parse(config))
  }

  private async notify(change: ConfigChange): Promise<void> {
    for (const entry of this.listeners) {
      if ('selector' in entry) {
        const previousValue = entry.selector(change.previous)
        const currentValue = entry.selector(change.current)
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
      await entry.listener(change)
    }
  }
}

export function diffConfigPaths(previous: unknown, current: unknown): string[] {
  const paths: string[] = []
  collectDiffPaths(previous, current, '', paths)
  return paths
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
