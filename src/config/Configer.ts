import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import YAML from 'yaml'
import { CodexioConfig, ConfigSchema, ConfigService, defaultConfigPath, parseCodexioConfigText } from '../ConfigService.js'

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
  private readonly service: ConfigService
  private readonly listeners = new Set<ConfigSubscriptionEntry>()
  readonly path: string

  constructor(path = defaultConfigPath) {
    this.path = resolve(path)
    this.service = new ConfigService(this.path)
  }

  async read(): Promise<CodexioConfig> {
    return this.service.load()
  }

  async init(force = false): Promise<CodexioConfig> {
    return this.service.init(force)
  }

  async replace(next: CodexioConfig): Promise<ConfigChange> {
    const previous = await this.read()
    const current = ConfigSchema.parse(next)
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

  async exportText(): Promise<string> {
    return YAML.stringify(await this.read())
  }

  async importText(text: string): Promise<ConfigChange> {
    const previous = await this.read()
    const current = await parseCodexioConfigText(text, this.path)
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

  async patch(patch: Partial<CodexioConfig>): Promise<ConfigChange> {
    const previous = await this.read()
    const current = ConfigSchema.parse(deepMergeConfig(previous as unknown as ConfigObject, patch as unknown as ConfigObject))
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

  private async write(config: CodexioConfig): Promise<void> {
    await mkdir(dirname(this.path), {
      recursive: true
    })
    const tempPath = join(dirname(this.path), `.config-${Date.now()}-${process.pid}.tmp`)
    try {
      await writeFile(tempPath, YAML.stringify(ConfigSchema.parse(config)), 'utf8')
      await rename(tempPath, this.path)
    } catch (error) {
      await rm(tempPath, {
        force: true
      })
      throw error
    }
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
