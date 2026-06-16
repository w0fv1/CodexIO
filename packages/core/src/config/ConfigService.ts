import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import YAML from 'yaml'
import { CodexioConfig, ConfigSchema } from './ConfigSchema.js'

export class ConfigService {
  constructor(private readonly configPath = join(homedir(), '.codexio', 'config.yaml')) {}

  get path(): string {
    return this.configPath
  }

  async load(): Promise<CodexioConfig> {
    const text = await readFile(this.configPath, 'utf8')
    const parsed = YAML.parse(text)
    const resolved = this.resolveReferences(parsed)
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
        return await this.load()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }
    }
    const workspacePath = process.env.INIT_CWD ?? process.cwd()
    const config = ConfigSchema.parse({
      server: {
        host: '127.0.0.1',
        port: 8787,
        publicUrl: 'http://127.0.0.1:8787'
      },
      proxy: {
        enabled: true,
        http: 'http://127.0.0.1:7890',
        https: 'http://127.0.0.1:7890',
        socks: 'socks5://127.0.0.1:7890',
        noProxy: [
          'localhost',
          '127.0.0.1'
        ]
      },
      defaultAgent: 'echo',
      agents: {
        echo: {
          enabled: true,
          command: 'echo',
          args: [],
          autoLoadSkill: false,
          env: {}
        },
        codex: {
          enabled: true,
          command: 'codex',
          args: [],
          autoLoadSkill: true,
          env: {
            HTTP_PROXY: '${proxy.http}',
            HTTPS_PROXY: '${proxy.https}',
            ALL_PROXY: '${proxy.socks}'
          }
        },
        claude: {
          enabled: true,
          command: 'claude',
          args: [],
          autoLoadSkill: true,
          env: {
            HTTP_PROXY: '${proxy.http}',
            HTTPS_PROXY: '${proxy.https}',
            ALL_PROXY: '${proxy.socks}'
          }
        }
      },
      channels: {
        web: {
          enabled: true
        },
        cli: {
          enabled: true
        }
      },
      workspaces: {
        default: {
          path: workspacePath,
          defaultAgent: 'echo',
          allowedChannels: [
            'web',
            'cli'
          ]
        }
      },
      routing: {
        defaultWorkspace: 'default',
        repoCommand: '/repo'
      },
      messaging: {
        maxOutboundChars: 1800,
        maxOutboundPerMinute: 3,
        allowMarkdown: true
      },
      security: {
        blockSecrets: true
      }
    })
    await this.save(config)
    return config
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
}
