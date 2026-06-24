import { existsSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'

export type CodexioConfig = {
  server: {
    host: string
    port: number
    token: string
    autoPort: boolean
  }
  proxy: {
    enabled: boolean
    host: string
    port: number
  }
  agents: {
    codex?: {
      enabled: boolean
      bundled?: boolean
    }
    claude?: {
      enabled: boolean
    }
  }
  channels: {
    web?: {
      enabled: boolean
    }
    feishu?: {
      enabled: boolean
      appId: string
      appSecret: string
      chatId: string
      ws: string
    }
    feishuWebhook?: {
      enabled: boolean
      url: string
    }
    email?: {
      enabled: boolean
      user: string
      agent: {
        imap: {
          host: string
          port: number
          secure: boolean
          user: string
          password: string
          mailbox: string
        }
        smtp: {
          host: string
          port: number
          secure: boolean
          user: string
          password: string
          from: string
        }
      }
      idle: boolean
      pollSeconds: number
    }
  }
  workspace: {
    path: string
  }
  update: {
    enabled: boolean
    baseUrl: string
  }
}

export type ConfigFieldDescriptor = {
  path: string
  group: string
  label: string
  type: 'boolean' | 'number' | 'string' | 'password'
  apply: string
}

type ConfigField = ConfigFieldDescriptor & {
  schema: z.ZodTypeAny
  default: unknown | (() => unknown)
}

type ConfigObject = Record<string, unknown>

const positiveInt = z.number().int().positive()

const configFields: ConfigField[] = [
  field('server.host', 'Server', 'Host', 'string', '重启 Codexio', z.string(), '127.0.0.1'),
  field('server.port', 'Server', 'Port', 'number', '重启 Codexio', positiveInt, 8787),
  field('server.token', 'Server', 'Token', 'password', '重启 Codexio', z.string(), ''),
  field('server.autoPort', 'Server', 'Auto Port', 'boolean', '重启 Codexio', z.boolean(), false),
  field('proxy.enabled', 'Proxy', 'Enabled', 'boolean', '重启 Agent', z.boolean(), false),
  field('proxy.host', 'Proxy', 'Host', 'string', '重启 Agent', z.string(), '127.0.0.1'),
  field('proxy.port', 'Proxy', 'Port', 'number', '重启 Agent', positiveInt, 7890),
  field('agents.codex.enabled', 'Agents', 'Codex', 'boolean', '重启 Agent', z.boolean(), true),
  field('agents.codex.bundled', 'Agents', 'Bundled Codex', 'boolean', '重启 Agent', z.boolean(), false),
  field('agents.claude.enabled', 'Agents', 'Claude', 'boolean', '重启 Agent', z.boolean(), false),
  field('workspace.path', 'Workspace', 'Path', 'string', '重启 Agent', z.string().min(1), '.'),
  field('channels.web.enabled', 'Web', 'Enabled', 'boolean', '重启 Codexio', z.boolean(), true),
  field('channels.feishu.enabled', 'Feishu', 'Enabled', 'boolean', '重连 Feishu', z.boolean(), false),
  field('channels.feishu.appId', 'Feishu', 'App ID', 'string', '重连 Feishu', z.string(), ''),
  field('channels.feishu.appSecret', 'Feishu', 'App Secret', 'password', '重连 Feishu', z.string(), ''),
  field('channels.feishu.chatId', 'Feishu', 'Chat ID', 'string', '重连 Feishu', z.string(), ''),
  field('channels.feishu.ws', 'Feishu', 'WebSocket', 'string', '重连 Feishu', z.string(), ''),
  field('channels.feishuWebhook.enabled', 'Feishu Webhook', 'Enabled', 'boolean', '重连 Feishu Webhook', z.boolean(), false),
  field('channels.feishuWebhook.url', 'Feishu Webhook', 'URL', 'password', '重连 Feishu Webhook', z.string(), ''),
  field('channels.email.enabled', 'Email', 'Enabled', 'boolean', '重连 Email', z.boolean(), false),
  field('channels.email.user', 'Email', 'User', 'string', '重连 Email', z.string(), ''),
  field('channels.email.agent.imap.host', 'Email IMAP', 'Host', 'string', '重连 Email', z.string(), ''),
  field('channels.email.agent.imap.port', 'Email IMAP', 'Port', 'number', '重连 Email', positiveInt, 993),
  field('channels.email.agent.imap.secure', 'Email IMAP', 'Secure', 'boolean', '重连 Email', z.boolean(), true),
  field('channels.email.agent.imap.user', 'Email IMAP', 'User', 'string', '重连 Email', z.string(), ''),
  field('channels.email.agent.imap.password', 'Email IMAP', 'Password', 'password', '重连 Email', z.string(), ''),
  field('channels.email.agent.imap.mailbox', 'Email IMAP', 'Mailbox', 'string', '重连 Email', z.string(), 'INBOX'),
  field('channels.email.agent.smtp.host', 'Email SMTP', 'Host', 'string', '重连 Email', z.string(), ''),
  field('channels.email.agent.smtp.port', 'Email SMTP', 'Port', 'number', '重连 Email', positiveInt, 465),
  field('channels.email.agent.smtp.secure', 'Email SMTP', 'Secure', 'boolean', '重连 Email', z.boolean(), true),
  field('channels.email.agent.smtp.user', 'Email SMTP', 'User', 'string', '重连 Email', z.string(), ''),
  field('channels.email.agent.smtp.password', 'Email SMTP', 'Password', 'password', '重连 Email', z.string(), ''),
  field('channels.email.agent.smtp.from', 'Email SMTP', 'From', 'string', '重连 Email', z.string(), ''),
  field('channels.email.idle', 'Email', 'Idle', 'boolean', '重连 Email', z.boolean(), true),
  field('channels.email.pollSeconds', 'Email', 'Poll Seconds', 'number', '重连 Email', positiveInt, 30),
  field('update.enabled', 'Update', 'Enabled', 'boolean', '立即生效', z.boolean(), true),
  field('update.baseUrl', 'Update', 'Base URL', 'string', '立即生效', z.string(), 'https://next.firco.cn')
]

export const configFieldDescriptors: ConfigFieldDescriptor[] = configFields.map(({ path, group, label, type, apply }) => ({
  path,
  group,
  label,
  type,
  apply
}))

export const ConfigSchema = z.preprocess((value) => deepMergeConfig(defaultConfigObject(), value), createConfigSchema())

export function createDefaultConfig(workspacePath = '.'): CodexioConfig {
  const config = ConfigSchema.parse(defaultConfigObject())
  config.server.token = createToken()
  config.workspace.path = normalizeWorkspacePath(workspacePath)
  return config
}

export async function parseCodexioConfig(value: unknown, configPath: string): Promise<CodexioConfig> {
  const resolved = resolveReferences(value ?? {})
  const config = ConfigSchema.parse(resolved)
  config.workspace.path = normalizeWorkspacePath(config.workspace.path, dirname(resolve(configPath)))
  return config
}

export function normalizeWorkspacePath(path: string, basePath = process.cwd()): string {
  const trimmedPath = path.trim()
  if (trimmedPath === '~') {
    return homedir()
  }
  if (trimmedPath.startsWith('~/') || trimmedPath.startsWith('~\\')) {
    return join(homedir(), trimmedPath.slice(2))
  }
  if (isAbsolute(trimmedPath)) {
    return trimmedPath
  }
  return resolve(basePath, trimmedPath)
}

export function validateCodexioConfig(config: CodexioConfig): void {
  const issues: string[] = []
  if (config.server.token.trim().length === 0) {
    issues.push('server.token is required')
  }
  const enabledAgents = Object.entries(config.agents).filter(([, agentConfig]) => agentConfig?.enabled)
  if (enabledAgents.length === 0) {
    issues.push('one agent must be enabled')
  }
  if (enabledAgents.length > 1) {
    issues.push('only one agent can be enabled')
  }
  if (existsSync(config.workspace.path) && !statSync(config.workspace.path).isDirectory()) {
    issues.push(`workspace.path is not a directory: ${config.workspace.path}`)
  }
  const enabledChannels = Object.entries(config.channels).filter(([, channelConfig]) => channelConfig?.enabled)
  if (enabledChannels.length === 0) {
    issues.push('one channel must be enabled')
  }
  if (config.channels.feishu?.enabled) {
    requireValue(issues, config.channels.feishu.appId, 'channels.feishu.appId is required')
    requireValue(issues, config.channels.feishu.appSecret, 'channels.feishu.appSecret is required')
    requireValue(issues, config.channels.feishu.chatId, 'channels.feishu.chatId is required')
  }
  if (config.channels.feishuWebhook?.enabled) {
    requireValue(issues, config.channels.feishuWebhook.url, 'channels.feishuWebhook.url is required')
  }
  if (config.channels.email?.enabled) {
    const email = config.channels.email
    requireValue(issues, email.user, 'channels.email.user is required')
    requireValue(issues, email.agent.imap.host, 'channels.email.agent.imap.host is required')
    requireValue(issues, email.agent.imap.user, 'channels.email.agent.imap.user is required')
    requireValue(issues, email.agent.imap.password, 'channels.email.agent.imap.password is required')
    requireValue(issues, email.agent.smtp.host, 'channels.email.agent.smtp.host is required')
    requireValue(issues, email.agent.smtp.user, 'channels.email.agent.smtp.user is required')
    requireValue(issues, email.agent.smtp.password, 'channels.email.agent.smtp.password is required')
  }
  if (issues.length > 0) {
    throw new Error([
      'Codexio config invalid:',
      ...issues.map((issue) => `- ${issue}`)
    ].join('\n'))
  }
}

function field(path: string, group: string, label: string, type: ConfigFieldDescriptor['type'], apply: string, schema: z.ZodTypeAny, defaultValue: unknown | (() => unknown)): ConfigField {
  return {
    path,
    group,
    label,
    type,
    apply,
    schema,
    default: defaultValue
  }
}

function createConfigSchema(): z.ZodType<CodexioConfig> {
  const tree: Record<string, unknown> = {}
  for (const item of configFields) {
    setPath(tree, item.path, item.schema.default(defaultValue(item.default)))
  }
  return buildSchema(tree) as z.ZodType<CodexioConfig>
}

function deepMergeConfig(left: unknown, right: unknown): unknown {
  if (!isPlainObject(left) || !isPlainObject(right)) {
    return right === undefined ? left : right
  }
  const merged: ConfigObject = {
    ...left
  }
  for (const [key, value] of Object.entries(right)) {
    merged[key] = deepMergeConfig(merged[key], value)
  }
  return merged
}

function isPlainObject(value: unknown): value is ConfigObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function buildSchema(value: unknown): z.ZodTypeAny {
  if (value && typeof value === 'object' && 'parse' in value) {
    return value as z.ZodTypeAny
  }
  const shape = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    buildSchema(item)
  ]))
  return z.object(shape).default({})
}

function defaultConfigObject(): ConfigObject {
  const result: ConfigObject = {}
  for (const item of configFields) {
    setPath(result, item.path, defaultValue(item.default))
  }
  return result
}

function defaultValue(value: unknown | (() => unknown)): unknown {
  return typeof value === 'function' ? value() : value
}

function setPath(object: ConfigObject, path: string, value: unknown): void {
  const keys = path.split('.')
  let current = object
  for (const key of keys.slice(0, -1)) {
    const next = current[key]
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      current[key] = {}
    }
    current = current[key] as ConfigObject
  }
  current[keys[keys.length - 1]] = value
}

function resolveReferences(value: unknown, root = value): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (_, path: string) => {
      const resolved = resolveReferencePath(root, path)
      if (typeof resolved === 'string') {
        return resolved
      }
      const envValue = process.env[path]
      if (envValue) {
        return envValue
      }
      return ''
    })
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveReferences(item, root))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      resolveReferences(item, root)
    ]))
  }
  return value
}

function resolveReferencePath(root: unknown, path: string): unknown {
  let current: unknown = root
  for (const key of path.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined
    }
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function requireValue(issues: string[], value: string, message: string): void {
  if (value.trim().length === 0) {
    issues.push(message)
  }
}

function createToken(): string {
  return randomBytes(32).toString('base64url')
}
