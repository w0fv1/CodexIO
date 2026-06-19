import { existsSync, statSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import YAML from 'yaml'
import { z } from 'zod'
import { codexioRootPath } from './AppMetadata.js'

export const defaultConfigPath = join(codexioRootPath, '.codexio', 'config.yaml')

const ProxyConfigSchema = z.object({
  enabled: z.boolean().default(false),
  host: z.string().default('127.0.0.1'),
  port: z.number().int().positive().default(7890)
})

const AgentConfigSchema = z.object({
  enabled: z.boolean().default(true)
})

const AgentsConfigSchema = z.object({
  codex: AgentConfigSchema.optional(),
  claude: AgentConfigSchema.optional()
})

const ChannelConfigSchema = z.object({
  enabled: z.boolean().default(true)
})

const FeishuChannelConfigSchema = ChannelConfigSchema.extend({
  appId: z.string().default(''),
  appSecret: z.string().default(''),
  chatId: z.string().default(''),
  ws: z.string().default('')
})

const FeishuWebhookChannelConfigSchema = ChannelConfigSchema.extend({
  url: z.string().default('')
})

const EmailServerConfigSchema = z.object({
  host: z.string().default(''),
  port: z.number().int().positive().default(993),
  secure: z.boolean().default(true),
  user: z.string().default(''),
  password: z.string().default('')
})

const EmailChannelConfigSchema = ChannelConfigSchema.extend({
  user: z.string().default(''),
  agent: z.object({
    imap: EmailServerConfigSchema.extend({
      mailbox: z.string().default('INBOX')
    }).default({
      host: '',
      port: 993,
      secure: true,
      user: '',
      password: '',
      mailbox: 'INBOX'
    }),
    smtp: EmailServerConfigSchema.extend({
      from: z.string().default('')
    }).default({
      host: '',
      port: 465,
      secure: true,
      user: '',
      password: '',
      from: ''
    })
  }).default({
    imap: {
      host: '',
      port: 993,
      secure: true,
      user: '',
      password: '',
      mailbox: 'INBOX'
    },
    smtp: {
      host: '',
      port: 465,
      secure: true,
      user: '',
      password: '',
      from: ''
    }
  }),
  idle: z.boolean().default(true),
  pollSeconds: z.number().int().positive().default(30)
})

const ChannelsConfigSchema = z.object({
  web: ChannelConfigSchema.optional(),
  feishu: FeishuChannelConfigSchema.optional(),
  feishuWebhook: FeishuWebhookChannelConfigSchema.optional(),
  email: EmailChannelConfigSchema.optional()
})

const WorkspaceConfigSchema = z.object({
  path: z.string().min(1)
})

const UpdateConfigSchema = z.object({
  enabled: z.boolean().default(true),
  baseUrl: z.string().default('https://next.firco.cn')
})

type ConfigReferenceObject = {
  [key: string]: ConfigReferenceValue | undefined
}
type ConfigReferenceValue = string | number | boolean | null | ConfigReferenceValue[] | ConfigReferenceObject

const ConfigReferenceValueSchema: z.ZodType<ConfigReferenceValue> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(ConfigReferenceValueSchema),
  z.record(z.string(), ConfigReferenceValueSchema)
]))

const ConfigDocumentSchema = z.object({
  server: ConfigReferenceValueSchema.optional(),
  proxy: ConfigReferenceValueSchema.optional(),
  agents: ConfigReferenceValueSchema.optional(),
  channels: ConfigReferenceValueSchema.optional(),
  workspace: ConfigReferenceValueSchema.optional(),
  update: ConfigReferenceValueSchema.optional(),
  defaultAgent: ConfigReferenceValueSchema.optional(),
  workspaces: ConfigReferenceValueSchema.optional(),
  routing: ConfigReferenceValueSchema.optional()
}).catchall(ConfigReferenceValueSchema)

const LegacyProxyConfigSchema = z.object({
  enabled: z.boolean().optional(),
  http: z.string().optional(),
  host: z.string().optional(),
  port: z.number().int().positive().optional()
}).catchall(ConfigReferenceValueSchema)

const LegacyWorkspaceSchema = z.object({
  path: z.string().optional()
}).catchall(ConfigReferenceValueSchema)

const LegacyRoutingSchema = z.object({
  defaultWorkspace: z.string().optional()
}).catchall(ConfigReferenceValueSchema)

const LegacyConfigSchema = ConfigDocumentSchema.extend({
  proxy: LegacyProxyConfigSchema.optional(),
  defaultAgent: z.string().optional(),
  workspaces: z.record(z.string(), LegacyWorkspaceSchema).optional(),
  routing: LegacyRoutingSchema.optional()
})

export const ConfigSchema = z.object({
  server: z.object({
    host: z.string().default('127.0.0.1'),
    port: z.number().int().positive().default(8787),
    token: z.string().default('')
  }).default({
    host: '127.0.0.1',
    port: 8787,
    token: ''
  }),
  proxy: ProxyConfigSchema.default({
    enabled: false,
    host: '127.0.0.1',
    port: 7890
  }),
  agents: AgentsConfigSchema.default({
    codex: {
      enabled: true
    },
    claude: {
      enabled: false
    }
  }),
  channels: ChannelsConfigSchema.default({}),
  workspace: WorkspaceConfigSchema.default({
    path: '.'
  }),
  update: UpdateConfigSchema.default({
    enabled: true,
    baseUrl: 'https://next.firco.cn'
  })
})

export type CodexioConfig = z.infer<typeof ConfigSchema>
type ConfigDocument = z.infer<typeof ConfigDocumentSchema>
type LegacyConfigDocument = z.infer<typeof LegacyConfigSchema>

export class ConfigService {
  private readonly configPath: string

  constructor(configPath = defaultConfigPath) {
    this.configPath = resolve(configPath)
  }

  get path(): string {
    return this.configPath
  }

  async load(): Promise<CodexioConfig> {
    const text = await readFile(this.configPath, 'utf8')
    const parsed = YAML.parse(text)
    const document = ConfigDocumentSchema.parse(parsed)
    const resolved = resolveReferences(migrateConfig(document))
    const config = ConfigSchema.parse(resolved)
    config.workspace.path = normalizeWorkspacePath(config.workspace.path, dirname(this.configPath))
    if (config.server.token.trim().length === 0) {
      config.server.token = createToken()
      await this.save(config)
    }
    return config
  }

  async save(config: CodexioConfig): Promise<void> {
    const checked = ConfigSchema.parse(config)
    await mkdir(dirname(this.configPath), {
      recursive: true
    })
    await writeFile(this.configPath, YAML.stringify(checked), 'utf8')
  }

  async init(force = false): Promise<CodexioConfig> {
    if (!force) {
      try {
        const config = await this.load()
        await this.save(config)
        return config
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }
    }
    const config = this.createDefaultConfig()
    await mkdir(config.workspace.path, {
      recursive: true
    })
    await this.save(config)
    return config
  }

  createDefaultConfig(workspacePath = join(codexioRootPath, '.codexio', 'workspace')): CodexioConfig {
    return ConfigSchema.parse({
      server: {
        host: '127.0.0.1',
        port: 8787,
        token: createToken()
      },
      proxy: {
        enabled: false,
        host: '127.0.0.1',
        port: 7890
      },
      agents: {
        codex: {
          enabled: true
        },
        claude: {
          enabled: false
        }
      },
      channels: {
        web: {
          enabled: true
        },
        feishu: {
          enabled: false,
          appId: '',
          appSecret: '',
          chatId: '',
          ws: ''
        },
        feishuWebhook: {
          enabled: false,
          url: ''
        },
        email: {
          enabled: false,
          user: '',
          agent: {
            imap: {
              host: '',
              port: 993,
              secure: true,
              user: '',
              password: '',
              mailbox: 'INBOX'
            },
            smtp: {
              host: '',
              port: 465,
              secure: true,
              user: '',
              password: '',
              from: ''
            }
          },
          idle: true,
          pollSeconds: 30
        }
      },
      workspace: {
        path: normalizeWorkspacePath(workspacePath, dirname(this.configPath))
      },
      update: {
        enabled: true,
        baseUrl: 'https://next.firco.cn'
      }
    })
  }
}

function migrateConfig(document: ConfigDocument): ConfigReferenceObject {
  const legacy = LegacyConfigSchema.parse(document)
  const migrated: ConfigReferenceObject = {
    ...legacy
  }
  const proxy = migrateProxyConfig(legacy)
  if (proxy) {
    migrated.proxy = proxy
  }
  const workspace = migrateWorkspaceConfig(legacy)
  if (workspace) {
    migrated.workspace = workspace
  }
  const agents = migrateAgentsConfig(legacy)
  if (agents) {
    migrated.agents = agents
  }
  const channels = migrateChannelsConfig(legacy)
  if (channels) {
    migrated.channels = channels
  }
  return migrated
}

function migrateProxyConfig(config: LegacyConfigDocument): ConfigReferenceObject | undefined {
  if (!config.proxy) {
    return undefined
  }
  const url = config.proxy.http ? new URL(config.proxy.http) : undefined
  return {
    enabled: config.proxy.enabled,
    host: url?.hostname ?? config.proxy.host,
    port: url?.port ? Number.parseInt(url.port, 10) : config.proxy.port
  }
}

function migrateWorkspaceConfig(config: LegacyConfigDocument): ConfigReferenceObject | undefined {
  if (!config.workspaces) {
    return undefined
  }
  const workspaceName = config.routing?.defaultWorkspace ?? 'default'
  const workspace = config.workspaces[workspaceName]
  if (!workspace?.path) {
    return undefined
  }
  return {
    path: workspace.path
  }
}

function migrateAgentsConfig(config: LegacyConfigDocument): ConfigReferenceObject | undefined {
  if (!config.defaultAgent) {
    return undefined
  }
  return {
    codex: {
      enabled: config.defaultAgent === 'codex'
    },
    claude: {
      enabled: config.defaultAgent === 'claude'
    }
  }
}

function migrateChannelsConfig(config: LegacyConfigDocument): ConfigReferenceObject | undefined {
  if (!config.channels || typeof config.channels !== 'object' || Array.isArray(config.channels)) {
    return undefined
  }
  const channels = config.channels as ConfigReferenceObject
  const email = channels.email
  if (!email || typeof email !== 'object' || Array.isArray(email)) {
    return undefined
  }
  const emailConfig = email as ConfigReferenceObject
  if (emailConfig.agent) {
    return undefined
  }
  const to = emailConfig.to
  const user = Array.isArray(to) ? to.find((item) => typeof item === 'string' && item.trim().length > 0) : undefined
  return {
    ...channels,
    email: {
      ...emailConfig,
      user,
      agent: {
        imap: emailConfig.imap,
        smtp: emailConfig.smtp
      },
      imap: undefined,
      smtp: undefined,
      to: undefined
    }
  }
}

function resolveReferences(value: ConfigReferenceValue, root = value): ConfigReferenceValue {
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
      item === undefined ? undefined : resolveReferences(item, root)
    ]))
  }
  return value
}

function resolveReferencePath(root: ConfigReferenceValue, path: string): ConfigReferenceValue | undefined {
  let current: ConfigReferenceValue | undefined = root
  for (const key of path.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined
    }
    current = current[key]
  }
  return current
}

export function normalizeWorkspacePath(path: string, basePath = codexioRootPath): string {
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
  const enabledAgents = Object.entries(config.agents).filter(([, agentConfig]) => agentConfig.enabled)
  if (enabledAgents.length === 0) {
    issues.push('one agent must be enabled')
  }
  if (enabledAgents.length > 1) {
    issues.push('only one agent can be enabled')
  }
  if (!existsSync(config.workspace.path)) {
    issues.push(`workspace.path does not exist: ${config.workspace.path}`)
  } else if (!statSync(config.workspace.path).isDirectory()) {
    issues.push(`workspace.path is not a directory: ${config.workspace.path}`)
  }
  const enabledChannels = Object.entries(config.channels).filter(([, channelConfig]) => channelConfig?.enabled)
  if (enabledChannels.length === 0) {
    issues.push('one channel must be enabled')
  }
  if (config.channels.feishu?.enabled) {
    if (config.channels.feishu.appId.trim().length === 0) {
      issues.push('channels.feishu.appId is required')
    }
    if (config.channels.feishu.appSecret.trim().length === 0) {
      issues.push('channels.feishu.appSecret is required')
    }
    if (config.channels.feishu.chatId.trim().length === 0) {
      issues.push('channels.feishu.chatId is required')
    }
  }
  if (config.channels.feishuWebhook?.enabled && config.channels.feishuWebhook.url.trim().length === 0) {
    issues.push('channels.feishuWebhook.url is required')
  }
  if (config.channels.email?.enabled) {
    const email = config.channels.email
    if (email.user.trim().length === 0) {
      issues.push('channels.email.user is required')
    }
    if (email.agent.imap.host.trim().length === 0) {
      issues.push('channels.email.agent.imap.host is required')
    }
    if (email.agent.imap.user.trim().length === 0) {
      issues.push('channels.email.agent.imap.user is required')
    }
    if (email.agent.imap.password.trim().length === 0) {
      issues.push('channels.email.agent.imap.password is required')
    }
    if (email.agent.smtp.host.trim().length === 0) {
      issues.push('channels.email.agent.smtp.host is required')
    }
    if (email.agent.smtp.user.trim().length === 0) {
      issues.push('channels.email.agent.smtp.user is required')
    }
    if (email.agent.smtp.password.trim().length === 0) {
      issues.push('channels.email.agent.smtp.password is required')
    }
  }
  if (issues.length > 0) {
    throw new Error([
      'Codexio config invalid:',
      ...issues.map((issue) => `- ${issue}`)
    ].join('\n'))
  }
}

function createToken(): string {
  return randomBytes(32).toString('base64url')
}
