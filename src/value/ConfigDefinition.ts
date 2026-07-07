import { randomBytes } from 'node:crypto'
import { z } from 'zod'

export type CodexioConfig = {
  server: {
    host: string
    port: number
    token: string
    autoPort: boolean
  }
  agents: {
    instruction: string
    echo: {
      enabled: boolean
    }
    codex: {
      enabled: boolean
      bundled: boolean
      command: string
      requestTimeoutSeconds: number
    }
  }
  workspace: {
    path: string
    perIoThread: boolean
  }
  proxy: {
    enabled: boolean
    host: string
    port: number
    noProxy: string
  }
  channeli: {
    web?: {
      enabled: boolean
    }
    feishu?: {
      enabled: boolean
      appId: string
      appSecret: string
      chatId: string
      ws: string
      aite: boolean
      allowedOpenIds: string[]
    }
    email?: {
      enabled: boolean
      user: string
      account: {
        imap: {
          host: string
          port: number
          secure: boolean
          user: string
          password: string
          mailbox: string
        }
      }
      idle: boolean
      pollSeconds: number
    }
    nfirco?: {
      enabled: boolean
      baseUrl: string
      account: string
      password: string
      section: string
    }
  }
  channelo: {
    web?: {
      enabled: boolean
    }
    feishu?: {
      enabled: boolean
      appId: string
      appSecret: string
      chatId: string
    }
    feishuWebhook?: {
      enabled: boolean
      url: string
    }
    email?: {
      enabled: boolean
      user: string
      account: {
        smtp: {
          host: string
          port: number
          secure: boolean
          user: string
          password: string
          from: string
        }
      }
    }
    nfirco?: {
      enabled: boolean
      baseUrl: string
      account: string
      password: string
    }
  }
}

export type ConfigFieldDescriptor = {
  path: string
  group: string
  label: string
  type: 'boolean' | 'number' | 'string' | 'password' | 'stringList'
  apply: string
}

type ConfigField = ConfigFieldDescriptor & {
  schema: z.ZodTypeAny
  default: unknown | (() => unknown)
}

type ConfigObject = Record<string, unknown>

const positiveInt = z.number().int().positive()
const workspacePath = z.preprocess((value) => value === null ? '~' : value, z.string())
const defaultCodexInstruction = [
  'When the user asks you to generate, edit, export, or provide an image or file, save the real output as a local file in the workspace or as an absolute local path.',
  'A preview, candidate, canvas, generated display, or tool-visible image is not deliverable unless you can reference a real file path or URL.',
  'The final answer must include the real file as a Markdown reference so Codexio can deliver it to the user.',
  'Use image syntax for images, for example ![name](absolute-or-workspace-relative-path).',
  'Use normal link syntax for other files, for example [name](absolute-or-workspace-relative-path).',
  'Do not answer only that the file has been generated, and do not rely on previews without a file path.'
].join('\n')

const configFields: ConfigField[] = [
  field('server.host', 'Server', 'Host', 'string', '重启 Codexio', z.string(), '127.0.0.1'),
  field('server.port', 'Server', 'Port', 'number', '重启 Codexio', positiveInt, 8787),
  field('server.token', 'Server', 'Token', 'password', '重启 Codexio', z.string(), ''),
  field('server.autoPort', 'Server', 'Auto Port', 'boolean', '重启 Codexio', z.boolean(), false),
  field('agents.instruction', 'Agents', 'Instruction', 'string', '重启 Agent', z.string(), defaultCodexInstruction),
  field('agents.echo.enabled', 'Echo Agent', 'Enabled', 'boolean', '重启 Echo Agent', z.boolean(), true),
  field('agents.codex.enabled', 'Codex Agent', 'Enabled', 'boolean', '重启 Codex Agent', z.boolean(), false),
  field('agents.codex.bundled', 'Codex Agent', 'Bundled', 'boolean', '重启 Codex Agent', z.boolean(), true),
  field('agents.codex.command', 'Codex Agent', 'Command', 'string', '重启 Codex Agent', z.string(), 'codex'),
  field('agents.codex.requestTimeoutSeconds', 'Codex Agent', 'Request Timeout Seconds', 'number', '重启 Codex Agent', positiveInt, 120),
  field('workspace.path', 'Workspace', 'Path', 'string', '重启 Codex Agent', workspacePath, ''),
  field('workspace.perIoThread', 'Workspace', 'Per IoThread', 'boolean', '重启 Codex Agent', z.boolean(), false),
  field('proxy.enabled', 'Proxy', 'Enabled', 'boolean', '重启 Codexio', z.boolean(), false),
  field('proxy.host', 'Proxy', 'Host', 'string', '重启 Codexio', z.string(), '127.0.0.1'),
  field('proxy.port', 'Proxy', 'Port', 'number', '重启 Codexio', positiveInt, 7890),
  field('proxy.noProxy', 'Proxy', 'NO_PROXY', 'string', '重启 Codexio', z.string(), ''),
  field('channeli.web.enabled', 'Web Input', 'Enabled', 'boolean', '重启 Codexio', z.boolean(), true),
  field('channeli.feishu.enabled', 'Feishu Input', 'Enabled', 'boolean', '重连 Feishu 输入', z.boolean(), false),
  field('channeli.feishu.appId', 'Feishu Input', 'App ID', 'string', '重连 Feishu 输入', z.string(), ''),
  field('channeli.feishu.appSecret', 'Feishu Input', 'App Secret', 'password', '重连 Feishu 输入', z.string(), ''),
  field('channeli.feishu.chatId', 'Feishu Input', 'Chat ID', 'string', '重连 Feishu 输入', z.string(), ''),
  field('channeli.feishu.ws', 'Feishu Input', 'WebSocket', 'string', '重连 Feishu 输入', z.string(), ''),
  field('channeli.feishu.aite', 'Feishu Input', 'Require Aite', 'boolean', '重连 Feishu 输入', z.boolean(), true),
  field('channeli.feishu.allowedOpenIds', 'Feishu Input', 'Allowed Open IDs', 'stringList', '重连 Feishu 输入', z.array(z.string()), []),
  field('channeli.email.enabled', 'Email Input', 'Enabled', 'boolean', '重连 Email 输入', z.boolean(), false),
  field('channeli.email.user', 'Email Input', 'User', 'string', '重连 Email 输入', z.string(), ''),
  field('channeli.email.account.imap.host', 'Email Input IMAP', 'Host', 'string', '重连 Email 输入', z.string(), ''),
  field('channeli.email.account.imap.port', 'Email Input IMAP', 'Port', 'number', '重连 Email 输入', positiveInt, 993),
  field('channeli.email.account.imap.secure', 'Email Input IMAP', 'Secure', 'boolean', '重连 Email 输入', z.boolean(), true),
  field('channeli.email.account.imap.user', 'Email Input IMAP', 'User', 'string', '重连 Email 输入', z.string(), ''),
  field('channeli.email.account.imap.password', 'Email Input IMAP', 'Password', 'password', '重连 Email 输入', z.string(), ''),
  field('channeli.email.account.imap.mailbox', 'Email Input IMAP', 'Mailbox', 'string', '重连 Email 输入', z.string(), 'INBOX'),
  field('channeli.email.idle', 'Email Input', 'Idle', 'boolean', '重连 Email 输入', z.boolean(), true),
  field('channeli.email.pollSeconds', 'Email Input', 'Poll Seconds', 'number', '重连 Email 输入', positiveInt, 30),
  field('channeli.nfirco.enabled', 'Nfirco Thread Input', 'Enabled', 'boolean', '重连 Nfirco Thread 输入', z.boolean(), false),
  field('channeli.nfirco.baseUrl', 'Nfirco Thread Input', 'Base URL', 'string', '重连 Nfirco Thread 输入', z.string(), ''),
  field('channeli.nfirco.account', 'Nfirco Thread Input', 'Account', 'string', '重连 Nfirco Thread 输入', z.string(), ''),
  field('channeli.nfirco.password', 'Nfirco Thread Input', 'Password', 'password', '重连 Nfirco Thread 输入', z.string(), ''),
  field('channeli.nfirco.section', 'Nfirco Thread Input', 'Section', 'string', '重连 Nfirco Thread 输入', z.string(), ''),
  field('channelo.web.enabled', 'Web Output', 'Enabled', 'boolean', '重启 Codexio', z.boolean(), true),
  field('channelo.feishu.enabled', 'Feishu Output', 'Enabled', 'boolean', '重连 Feishu 输出', z.boolean(), false),
  field('channelo.feishu.appId', 'Feishu Output', 'App ID', 'string', '重连 Feishu 输出', z.string(), ''),
  field('channelo.feishu.appSecret', 'Feishu Output', 'App Secret', 'password', '重连 Feishu 输出', z.string(), ''),
  field('channelo.feishu.chatId', 'Feishu Output', 'Chat ID', 'string', '重连 Feishu 输出', z.string(), ''),
  field('channelo.feishuWebhook.enabled', 'Feishu Webhook Output', 'Enabled', 'boolean', '重连 Feishu Webhook 输出', z.boolean(), false),
  field('channelo.feishuWebhook.url', 'Feishu Webhook Output', 'URL', 'password', '重连 Feishu Webhook 输出', z.string(), ''),
  field('channelo.email.enabled', 'Email Output', 'Enabled', 'boolean', '重连 Email 输出', z.boolean(), false),
  field('channelo.email.user', 'Email Output', 'User', 'string', '重连 Email 输出', z.string(), ''),
  field('channelo.email.account.smtp.host', 'Email Output SMTP', 'Host', 'string', '重连 Email 输出', z.string(), ''),
  field('channelo.email.account.smtp.port', 'Email Output SMTP', 'Port', 'number', '重连 Email 输出', positiveInt, 465),
  field('channelo.email.account.smtp.secure', 'Email Output SMTP', 'Secure', 'boolean', '重连 Email 输出', z.boolean(), true),
  field('channelo.email.account.smtp.user', 'Email Output SMTP', 'User', 'string', '重连 Email 输出', z.string(), ''),
  field('channelo.email.account.smtp.password', 'Email Output SMTP', 'Password', 'password', '重连 Email 输出', z.string(), ''),
  field('channelo.email.account.smtp.from', 'Email Output SMTP', 'From', 'string', '重连 Email 输出', z.string(), ''),
  field('channelo.nfirco.enabled', 'Nfirco Thread Output', 'Enabled', 'boolean', '重连 Nfirco Thread 输出', z.boolean(), false),
  field('channelo.nfirco.baseUrl', 'Nfirco Thread Output', 'Base URL', 'string', '重连 Nfirco Thread 输出', z.string(), ''),
  field('channelo.nfirco.account', 'Nfirco Thread Output', 'Account', 'string', '重连 Nfirco Thread 输出', z.string(), ''),
  field('channelo.nfirco.password', 'Nfirco Thread Output', 'Password', 'password', '重连 Nfirco Thread 输出', z.string(), '')
]

export const configFieldDescriptors: ConfigFieldDescriptor[] = configFields.map(({ path, group, label, type, apply }) => ({
  path,
  group,
  label,
  type,
  apply
}))

export const ConfigSchema = z.preprocess((value) => deepMergeConfig(defaultConfigObject(), value), createConfigSchema())

export function createDefaultConfig(): CodexioConfig {
  const config = ConfigSchema.parse(defaultConfigObject())
  config.server.token = createToken()
  return config
}

export async function parseCodexioConfig(value: unknown, _configPath: string): Promise<CodexioConfig> {
  const resolved = resolveReferences(value ?? {})
  return ConfigSchema.parse(resolved)
}

export function validateCodexioConfig(config: CodexioConfig): void {
  const issues: string[] = []
  if (config.server.token.trim().length === 0) {
    issues.push('server.token is required')
  }
  const enabledAgents = [
    config.agents.codex,
    config.agents.echo
  ].filter((agentConfig) => agentConfig.enabled)
  if (enabledAgents.length === 0) {
    issues.push('one agent must be enabled')
  }
  const enabledChanneli = Object.entries(config.channeli).filter(([, channelConfig]) => channelConfig?.enabled)
  const enabledChannelo = Object.entries(config.channelo).filter(([, channelConfig]) => channelConfig?.enabled)
  if (enabledChanneli.length === 0) {
    issues.push('one channeli must be enabled')
  }
  if (enabledChannelo.length === 0) {
    issues.push('one channelo must be enabled')
  }
  if (config.channeli.feishu?.enabled) {
    requireValue(issues, config.channeli.feishu.appId, 'channeli.feishu.appId is required')
    requireValue(issues, config.channeli.feishu.appSecret, 'channeli.feishu.appSecret is required')
    requireValue(issues, config.channeli.feishu.chatId, 'channeli.feishu.chatId is required')
  }
  if (config.channelo.feishu?.enabled) {
    requireValue(issues, config.channelo.feishu.appId, 'channelo.feishu.appId is required')
    requireValue(issues, config.channelo.feishu.appSecret, 'channelo.feishu.appSecret is required')
    requireValue(issues, config.channelo.feishu.chatId, 'channelo.feishu.chatId is required')
  }
  if (config.channelo.feishuWebhook?.enabled) {
    requireValue(issues, config.channelo.feishuWebhook.url, 'channelo.feishuWebhook.url is required')
  }
  if (config.channeli.email?.enabled) {
    const email = config.channeli.email
    requireValue(issues, email.user, 'channeli.email.user is required')
    requireValue(issues, email.account.imap.host, 'channeli.email.account.imap.host is required')
    requireValue(issues, email.account.imap.user, 'channeli.email.account.imap.user is required')
    requireValue(issues, email.account.imap.password, 'channeli.email.account.imap.password is required')
  }
  if (config.channeli.nfirco?.enabled) {
    const nfirco = config.channeli.nfirco
    requireValue(issues, nfirco.baseUrl, 'channeli.nfirco.baseUrl is required')
    requireValue(issues, nfirco.account, 'channeli.nfirco.account is required')
    requireValue(issues, nfirco.password, 'channeli.nfirco.password is required')
    requireValue(issues, nfirco.section, 'channeli.nfirco.section is required')
  }
  if (config.channelo.email?.enabled) {
    const email = config.channelo.email
    requireValue(issues, email.user, 'channelo.email.user is required')
    requireValue(issues, email.account.smtp.host, 'channelo.email.account.smtp.host is required')
    requireValue(issues, email.account.smtp.user, 'channelo.email.account.smtp.user is required')
    requireValue(issues, email.account.smtp.password, 'channelo.email.account.smtp.password is required')
  }
  if (config.channelo.nfirco?.enabled) {
    const nfirco = config.channelo.nfirco
    requireValue(issues, nfirco.baseUrl, 'channelo.nfirco.baseUrl is required')
    requireValue(issues, nfirco.account, 'channelo.nfirco.account is required')
    requireValue(issues, nfirco.password, 'channelo.nfirco.password is required')
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
