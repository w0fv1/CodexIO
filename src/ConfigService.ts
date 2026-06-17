import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import YAML from 'yaml'
import { z } from 'zod'

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
  appSecret: z.string().default('')
})

const ChannelsConfigSchema = z.object({
  web: ChannelConfigSchema.optional(),
  feishu: FeishuChannelConfigSchema.optional()
})

const WorkspaceConfigSchema = z.object({
  path: z.string().min(1)
})

export const ConfigSchema = z.object({
  server: z.object({
    host: z.string().default('127.0.0.1'),
    port: z.number().int().positive().default(8787)
  }).default({
    host: '127.0.0.1',
    port: 8787
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

export class ConfigService {
  constructor(private readonly configPath = join(homedir(), '.codexio', 'config.yaml')) {}

  get path(): string {
    return this.configPath
  }

  async load(): Promise<CodexioConfig> {
    const text = await readFile(this.configPath, 'utf8')
    const parsed = YAML.parse(text)
    const resolved = this.resolveReferences(this.migrate(parsed))
    return ConfigSchema.parse(resolved)
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
        port: 8787
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
          appSecret: ''
        }
      },
      workspace: {
        path: workspacePath
      }
    })
  }

  private resolveReferences(value: unknown, root = value): unknown {
    if (typeof value === 'string') {
      return value.replace(/\$\{([^}]+)\}/g, (_, path: string) => {
        const resolved = path.split('.').reduce<unknown>((current, key) => {
          if (current && typeof current === 'object' && key in current) {
            return (current as Record<string, unknown>)[key]
          }
          return undefined
        }, root)
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
      return value.map((item) => this.resolveReferences(item, root))
    }
    if (value && typeof value === 'object') {
      const entries = Object.entries(value).map(([key, item]) => [
        key,
        this.resolveReferences(item, root)
      ])
      return Object.fromEntries(entries)
    }
    return value
  }

  private migrate(value: unknown): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return value
    }
    const source = value as Record<string, unknown>
    const migrated = {
      ...source
    }
    const oldProxy = source.proxy
    if (oldProxy && typeof oldProxy === 'object' && !Array.isArray(oldProxy)) {
      const proxy = oldProxy as Record<string, unknown>
      const url = typeof proxy.http === 'string' ? new URL(proxy.http) : undefined
      migrated.proxy = {
        enabled: proxy.enabled,
        host: url?.hostname ?? proxy.host,
        port: url?.port ? Number.parseInt(url.port, 10) : proxy.port
      }
    }
    const oldWorkspace = source.workspaces
    if (oldWorkspace && typeof oldWorkspace === 'object' && !Array.isArray(oldWorkspace)) {
      const workspaces = oldWorkspace as Record<string, unknown>
      const defaultWorkspace = source.routing && typeof source.routing === 'object' && !Array.isArray(source.routing)
        ? (source.routing as Record<string, unknown>).defaultWorkspace
        : undefined
      const workspaceName = typeof defaultWorkspace === 'string' ? defaultWorkspace : 'default'
      const workspace = workspaces[workspaceName]
      if (workspace && typeof workspace === 'object' && !Array.isArray(workspace)) {
        migrated.workspace = {
          path: (workspace as Record<string, unknown>).path
        }
      }
    }
    if (typeof source.defaultAgent === 'string') {
      migrated.agents = {
        codex: {
          enabled: source.defaultAgent === 'codex'
        },
        claude: {
          enabled: source.defaultAgent === 'claude'
        },
        echo: {
          enabled: source.defaultAgent === 'echo'
        }
      }
    }
    return migrated
  }
}
