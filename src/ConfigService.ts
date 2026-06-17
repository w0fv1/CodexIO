import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { z } from 'zod'

let codexioRoot = dirname(fileURLToPath(import.meta.url))
while (!existsSync(join(codexioRoot, 'package.json')) && dirname(codexioRoot) !== codexioRoot) {
  codexioRoot = dirname(codexioRoot)
}

export const defaultConfigPath = join(codexioRoot, '.codexio', 'config.yaml')

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
  claude: AgentConfigSchema.optional(),
  echo: AgentConfigSchema.optional()
})

const ChannelConfigSchema = z.object({
  enabled: z.boolean().default(true)
})

const FeishuChannelConfigSchema = ChannelConfigSchema.extend({
  appId: z.string().default(''),
  appSecret: z.string().default(''),
  chatIds: z.array(z.string()).default([])
})

const ChannelsConfigSchema = z.object({
  web: ChannelConfigSchema.optional(),
  feishu: FeishuChannelConfigSchema.optional()
})

const WorkspaceConfigSchema = z.object({
  path: z.string().min(1)
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
    messageToken: z.string().default('')
  }).default({
    host: '127.0.0.1',
    port: 8787,
    messageToken: ''
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
  })
})

export type CodexioConfig = z.infer<typeof ConfigSchema>
type ConfigDocument = z.infer<typeof ConfigDocumentSchema>
type LegacyConfigDocument = z.infer<typeof LegacyConfigSchema>

export class ConfigService {
  constructor(private readonly configPath = defaultConfigPath) {}

  get path(): string {
    return this.configPath
  }

  async load(): Promise<CodexioConfig> {
    const text = await readFile(this.configPath, 'utf8')
    const parsed = YAML.parse(text)
    const document = ConfigDocumentSchema.parse(parsed)
    const resolved = resolveReferences(migrateConfig(document))
    const config = ConfigSchema.parse(resolved)
    if (config.server.messageToken.trim().length === 0) {
      config.server.messageToken = createMessageToken()
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
    const config = this.createDefaultConfig(process.env.INIT_CWD ?? process.cwd())
    await this.save(config)
    return config
  }

  createDefaultConfig(workspacePath = process.cwd()): CodexioConfig {
    return ConfigSchema.parse({
      server: {
        host: '127.0.0.1',
        port: 8787,
        messageToken: createMessageToken()
      },
      proxy: {
        enabled: true,
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
          chatIds: []
        }
      },
      workspace: {
        path: workspacePath
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
    },
    echo: {
      enabled: config.defaultAgent === 'echo'
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

function createMessageToken(): string {
  return randomBytes(32).toString('base64url')
}
