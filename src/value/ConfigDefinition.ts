import { randomBytes } from 'node:crypto'
import { z } from 'zod'

export type ConfigFieldDescriptor = {
  path: string
  groupPath: string
  label: string
  description: string
  type: 'boolean' | 'number' | 'string' | 'password' | 'stringList'
  apply: string
}

export type ConfigGroupDescriptor = {
  path: string
  title: string
  description: string
}

export type ConfigDescriptor = {
  groups: ConfigGroupDescriptor[]
  fields: ConfigFieldDescriptor[]
}

type ConfigFieldDefinition<S extends z.ZodTypeAny = z.ZodTypeAny> = ConfigFieldDescriptor & {
  kind: 'field'
  schema: S
  default: z.output<S> | (() => z.output<S>)
}

type ConfigGroupDefinition<T extends ConfigDefinitionMap = ConfigDefinitionMap> = {
  kind: 'group'
  title: string
  description: string
  fields: T
}

type ConfigDefinitionNode = ConfigFieldDefinition | ConfigGroupDefinition | ConfigDefinitionMap
type ConfigDefinitionMap = {
  [key: string]: ConfigDefinitionNode
}
type ConfigObject = Record<string, unknown>
type InferConfigNode<T> = T extends ConfigFieldDefinition<infer S>
  ? z.output<S>
  : T extends ConfigGroupDefinition<infer F>
    ? InferConfig<F>
    : T extends ConfigDefinitionMap
      ? InferConfig<T>
      : never

export type InferConfig<T extends ConfigDefinitionMap> = {
  [K in keyof T]: InferConfigNode<T[K]>
}

const positiveInt = z.number().int().positive()
const workspacePath = z.preprocess((value) => value === null ? '~' : value, z.string())
const optionalString = z.preprocess((value) => value === null ? '' : value, z.string())
const defaultCodexInstruction = [
  'When the user asks you to generate, edit, export, or provide an image or file, save the real output as a local file in the workspace or as an absolute local path.',
  'A preview, candidate, canvas, generated display, or tool-visible image is not deliverable unless you can reference a real file path or URL.',
  'The final answer must include the real file as a Markdown reference so Codexio can deliver it to the user.',
  'Use image syntax for images, for example ![name](absolute-or-workspace-relative-path).',
  'Use normal link syntax for other files, for example [name](absolute-or-workspace-relative-path).',
  'Do not answer only that the file has been generated, and do not rely on previews without a file path.'
].join('\n')

export const configDefinition = defineConfig({
  app: group({
    title: 'App'
  }, {
    id: field({
      label: 'ID',
      description: '本次 Codexio 启动生成的 appid。',
      type: 'string',
      apply: '重启 Codexio',
      schema: z.string(),
      default: ''
    }),
    startAtLogin: field({
      label: '开机启动',
      description: '登录 Windows 后自动启动 Codexio。仅 Windows 桌面安装版执行此设置。',
      type: 'boolean',
      apply: '立即生效',
      schema: z.boolean(),
      default: false
    }),
    preventSystemSleep: field({
      label: '阻止系统睡眠',
      description: 'Codexio 运行期间阻止系统自动进入睡眠，允许屏幕关闭。仅桌面版生效。',
      type: 'boolean',
      apply: '立即生效',
      schema: z.boolean(),
      default: true
    }),
    workspace: group({
      title: 'Workspace',
      description: 'Codexio Agent 使用的默认工作区。'
    }, {
      path: field({
        label: 'Path',
        description: '默认工作目录。相对路径以 Codexio 数据目录为基准。',
        type: 'string',
        apply: '重启 Codex Agent',
        schema: workspacePath,
        default: 'workspace'
      }),
      perIoThread: field({
        label: 'Per IoThread',
        description: '为每个 IoThread 使用独立子工作目录。',
        type: 'boolean',
        apply: '重启 Codex Agent',
        schema: z.boolean(),
        default: false
      })
    })
  }),
  server: group({
    title: 'Server'
  }, {
    host: field({
      label: 'Host',
      description: 'Codexio HTTP 服务监听地址。',
      type: 'string',
      apply: '重启 Codexio',
      schema: z.string(),
      default: '127.0.0.1'
    }),
    port: field({
      label: 'Port',
      description: 'Codexio HTTP 服务监听端口。',
      type: 'number',
      apply: '重启 Codexio',
      schema: positiveInt,
      default: 8787
    }),
    token: field({
      label: 'Token',
      description: '调用管理 API 时使用的 Bearer Token。',
      type: 'password',
      apply: '重启 Codexio',
      schema: z.string(),
      default: ''
    }),
    autoPort: field({
      label: 'Auto Port',
      description: '端口被占用时从首选端口开始递增寻找可用端口，不修改首选端口配置。',
      type: 'boolean',
      apply: '重启 Codexio',
      schema: z.boolean(),
      default: false
    })
  }),
  agents: group({
    title: 'Agents'
  }, {
    instruction: field({
      label: 'Instruction',
      description: '注入给 Agent 的共享运行指令。',
      type: 'string',
      apply: '重启 Agent',
      schema: z.string(),
      default: defaultCodexInstruction
    }),
    echo: group({
      title: 'Echo Agent'
    }, {
      enabled: field({
        label: 'Enabled',
        description: '启用直接回显用户消息的测试 Agent。',
        type: 'boolean',
        apply: '重启 Echo Agent',
        schema: z.boolean(),
        default: true
      })
    }),
    codex: group({
      title: 'Codex Agent'
    }, {
      enabled: field({
        label: 'Enabled',
        description: '启用 Codex 命令行 Agent。',
        type: 'boolean',
        apply: '重启 Codex Agent',
        schema: z.boolean(),
        default: false
      }),
      bundled: field({
        label: 'Bundled',
        description: '使用 Codexio 内置的 Codex 运行环境。',
        type: 'boolean',
        apply: '重启 Codex Agent',
        schema: z.boolean(),
        default: true
      }),
      command: field({
        label: 'Command',
        description: '未使用内置运行环境时执行的 Codex 命令。',
        type: 'string',
        apply: '重启 Codex Agent',
        schema: z.string(),
        default: 'codex'
      }),
      model: field({
        label: 'Model',
        description: 'Codex 使用的模型。',
        type: 'string',
        apply: '重启 Codex Agent',
        schema: z.string().min(1),
        default: 'gpt-5.6-sol'
      }),
      reasoningEffort: field({
        label: 'Reasoning Effort',
        description: 'Codex 的推理强度。',
        type: 'string',
        apply: '重启 Codex Agent',
        schema: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max']),
        default: 'medium'
      }),
      requestTimeoutSeconds: field({
        label: 'Request Timeout Seconds',
        description: '单次 Codex 请求等待超时时间。',
        type: 'number',
        apply: '重启 Codex Agent',
        schema: positiveInt,
        default: 120
      })
    })
  }),
  proxy: group({
    title: 'Proxy'
  }, {
    enabled: field({
      label: 'Enabled',
      description: '为 Codex 进程注入 HTTP_PROXY、HTTPS_PROXY 和 NO_PROXY。',
      type: 'boolean',
      apply: '重启 Codexio',
      schema: z.boolean(),
      default: false
    }),
    host: field({
      label: 'Host',
      description: '代理服务主机地址。',
      type: 'string',
      apply: '重启 Codexio',
      schema: z.string(),
      default: '127.0.0.1'
    }),
    port: field({
      label: 'Port',
      description: '代理服务端口。',
      type: 'number',
      apply: '重启 Codexio',
      schema: positiveInt,
      default: 7890
    }),
    noProxy: field({
      label: 'NO_PROXY',
      description: '不走代理的主机列表，按逗号分隔。',
      type: 'string',
      apply: '重启 Codexio',
      schema: z.string(),
      default: ''
    })
  }),
  channeli: {
    web: group({
      title: 'Web Input'
    }, {
      enabled: field({
        label: 'Enabled',
        description: '启用网页对话输入通道。',
        type: 'boolean',
        apply: '重启 Codexio',
        schema: z.boolean(),
        default: true
      })
    }),
    feishu: group({
      title: 'Feishu Input',
      description: '在已经引入 Codexio 的飞书群聊中，或与 Codexio 私聊时，输入 $bind ${app.id} 即可在飞书中绑定 Codexio。'
    }, {
      enabled: field({
        label: 'Enabled',
        description: '启用飞书 WebSocket 输入通道。',
        type: 'boolean',
        apply: '重连 Feishu 输入',
        schema: z.boolean(),
        default: false
      }),
      appId: field({
        label: 'App ID',
        description: '飞书应用的 App ID。',
        type: 'string',
        apply: '重连 Feishu 输入',
        schema: z.string(),
        default: ''
      }),
      appSecret: field({
        label: 'App Secret',
        description: '飞书应用的 App Secret。',
        type: 'password',
        apply: '重连 Feishu 输入',
        schema: z.string(),
        default: ''
      }),
      chatId: field({
        label: 'Chat ID',
        description: '允许接收消息的飞书群聊 ID。',
        type: 'string',
        apply: '重连 Feishu 输入',
        schema: optionalString,
        default: ''
      }),
      ws: field({
        label: 'WebSocket',
        description: '飞书长连接地址，留空时由飞书 SDK 自动获取。',
        type: 'string',
        apply: '重连 Feishu 输入',
        schema: z.string(),
        default: ''
      }),
      aite: field({
        label: 'Require Aite',
        description: '只处理明确提及机器人的飞书消息。',
        type: 'boolean',
        apply: '重连 Feishu 输入',
        schema: z.boolean(),
        default: true
      }),
      allowedOpenIds: field({
        label: 'Allowed Open IDs',
        description: '允许触发输入的飞书用户 Open ID 列表，留空表示不限制。',
        type: 'stringList',
        apply: '重连 Feishu 输入',
        schema: z.array(z.string()),
        default: []
      })
    }),
    email: group({
      title: 'Email Input'
    }, {
      enabled: field({
        label: 'Enabled',
        description: '启用邮件输入通道。',
        type: 'boolean',
        apply: '重连 Email 输入',
        schema: z.boolean(),
        default: false
      }),
      user: field({
        label: 'User',
        description: '接收邮件时代表的 Codexio 用户标识。',
        type: 'string',
        apply: '重连 Email 输入',
        schema: z.string(),
        default: ''
      }),
      account: {
        imap: group({
          title: 'Email Input IMAP'
        }, {
          host: field({
            label: 'Host',
            description: 'IMAP 服务器地址。',
            type: 'string',
            apply: '重连 Email 输入',
            schema: z.string(),
            default: ''
          }),
          port: field({
            label: 'Port',
            description: 'IMAP 服务器端口。',
            type: 'number',
            apply: '重连 Email 输入',
            schema: positiveInt,
            default: 993
          }),
          secure: field({
            label: 'Secure',
            description: 'IMAP 连接是否使用 TLS。',
            type: 'boolean',
            apply: '重连 Email 输入',
            schema: z.boolean(),
            default: true
          }),
          user: field({
            label: 'User',
            description: 'IMAP 登录用户名。',
            type: 'string',
            apply: '重连 Email 输入',
            schema: z.string(),
            default: ''
          }),
          password: field({
            label: 'Password',
            description: 'IMAP 登录密码或应用专用密码。',
            type: 'password',
            apply: '重连 Email 输入',
            schema: z.string(),
            default: ''
          }),
          mailbox: field({
            label: 'Mailbox',
            description: '监听的邮箱文件夹名称。',
            type: 'string',
            apply: '重连 Email 输入',
            schema: z.string(),
            default: 'INBOX'
          })
        })
      },
      idle: field({
        label: 'Idle',
        description: '使用 IMAP IDLE 实时等待新邮件。',
        type: 'boolean',
        apply: '重连 Email 输入',
        schema: z.boolean(),
        default: true
      }),
      pollSeconds: field({
        label: 'Poll Seconds',
        description: '未使用实时等待时的轮询间隔秒数。',
        type: 'number',
        apply: '重连 Email 输入',
        schema: positiveInt,
        default: 30
      })
    }),
    nfirco: group({
      title: 'Nfirco Thread Input'
    }, {
      enabled: field({
        label: 'Enabled',
        description: '启用 Nfirco Thread 输入通道。',
        type: 'boolean',
        apply: '重连 Nfirco Thread 输入',
        schema: z.boolean(),
        default: false
      }),
      baseUrl: field({
        label: 'Base URL',
        description: 'Nfirco 后端基础地址。',
        type: 'string',
        apply: '重连 Nfirco Thread 输入',
        schema: z.string(),
        default: ''
      }),
      account: field({
        label: 'Account',
        description: '连接 Nfirco Thread API 的账号。',
        type: 'string',
        apply: '重连 Nfirco Thread 输入',
        schema: z.string(),
        default: ''
      }),
      password: field({
        label: 'Password',
        description: '连接 Nfirco Thread API 的密码。',
        type: 'password',
        apply: '重连 Nfirco Thread 输入',
        schema: z.string(),
        default: ''
      }),
      section: field({
        label: 'Section',
        description: '订阅的 Nfirco Thread 分区。',
        type: 'string',
        apply: '重连 Nfirco Thread 输入',
        schema: z.string(),
        default: ''
      })
    })
  },
  channelo: {
    web: group({
      title: 'Web Output'
    }, {
      enabled: field({
        label: 'Enabled',
        description: '启用网页对话输出通道。',
        type: 'boolean',
        apply: '重启 Codexio',
        schema: z.boolean(),
        default: true
      })
    }),
    feishu: group({
      title: 'Feishu Output'
    }, {
      enabled: field({
        label: 'Enabled',
        description: '启用飞书群聊输出通道。',
        type: 'boolean',
        apply: '重连 Feishu 输出',
        schema: z.boolean(),
        default: false
      }),
      appId: field({
        label: 'App ID',
        description: '飞书应用的 App ID。',
        type: 'string',
        apply: '重连 Feishu 输出',
        schema: z.string(),
        default: ''
      }),
      appSecret: field({
        label: 'App Secret',
        description: '飞书应用的 App Secret。',
        type: 'password',
        apply: '重连 Feishu 输出',
        schema: z.string(),
        default: ''
      }),
      chatId: field({
        label: 'Chat ID',
        description: '发送消息的飞书群聊 ID。',
        type: 'string',
        apply: '重连 Feishu 输出',
        schema: optionalString,
        default: ''
      })
    }),
    feishuWebhook: group({
      title: 'Feishu Webhook Output'
    }, {
      enabled: field({
        label: 'Enabled',
        description: '启用飞书机器人 Webhook 输出通道。',
        type: 'boolean',
        apply: '重连 Feishu Webhook 输出',
        schema: z.boolean(),
        default: false
      }),
      url: field({
        label: 'URL',
        description: '飞书机器人 Webhook 地址。',
        type: 'password',
        apply: '重连 Feishu Webhook 输出',
        schema: z.string(),
        default: ''
      })
    }),
    email: group({
      title: 'Email Output'
    }, {
      enabled: field({
        label: 'Enabled',
        description: '启用邮件输出通道。',
        type: 'boolean',
        apply: '重连 Email 输出',
        schema: z.boolean(),
        default: false
      }),
      user: field({
        label: 'User',
        description: '接收 Agent 输出邮件的目标邮箱。',
        type: 'string',
        apply: '重连 Email 输出',
        schema: z.string(),
        default: ''
      }),
      account: {
        smtp: group({
          title: 'Email Output SMTP'
        }, {
          host: field({
            label: 'Host',
            description: 'SMTP 服务器地址。',
            type: 'string',
            apply: '重连 Email 输出',
            schema: z.string(),
            default: ''
          }),
          port: field({
            label: 'Port',
            description: 'SMTP 服务器端口。',
            type: 'number',
            apply: '重连 Email 输出',
            schema: positiveInt,
            default: 465
          }),
          secure: field({
            label: 'Secure',
            description: 'SMTP 连接是否使用 TLS。',
            type: 'boolean',
            apply: '重连 Email 输出',
            schema: z.boolean(),
            default: true
          }),
          user: field({
            label: 'User',
            description: 'SMTP 登录用户名。',
            type: 'string',
            apply: '重连 Email 输出',
            schema: z.string(),
            default: ''
          }),
          password: field({
            label: 'Password',
            description: 'SMTP 登录密码或应用专用密码。',
            type: 'password',
            apply: '重连 Email 输出',
            schema: z.string(),
            default: ''
          }),
          from: field({
            label: 'From',
            description: '邮件发件人地址，留空时使用 SMTP 用户名。',
            type: 'string',
            apply: '重连 Email 输出',
            schema: z.string(),
            default: ''
          })
        })
      }
    }),
    nfirco: group({
      title: 'Nfirco Thread Output'
    }, {
      enabled: field({
        label: 'Enabled',
        description: '启用 Nfirco Thread 输出通道。',
        type: 'boolean',
        apply: '重连 Nfirco Thread 输出',
        schema: z.boolean(),
        default: false
      }),
      baseUrl: field({
        label: 'Base URL',
        description: 'Nfirco 后端基础地址。',
        type: 'string',
        apply: '重连 Nfirco Thread 输出',
        schema: z.string(),
        default: ''
      }),
      account: field({
        label: 'Account',
        description: '连接 Nfirco Thread API 的账号。',
        type: 'string',
        apply: '重连 Nfirco Thread 输出',
        schema: z.string(),
        default: ''
      }),
      password: field({
        label: 'Password',
        description: '连接 Nfirco Thread API 的密码。',
        type: 'password',
        apply: '重连 Nfirco Thread 输出',
        schema: z.string(),
        default: ''
      }),
      section: field({
        label: 'Section',
        description: '创建 Nfirco Thread 主题的分区。',
        type: 'string',
        apply: '重连 Nfirco Thread 输出',
        schema: z.string(),
        default: ''
      })
    })
  }
})

type NormalizedConfigField = ConfigFieldDefinition & {
  path: string
  groupPath: string
}

export type CodexioConfig = InferConfig<typeof configDefinition>

const normalizedConfigDefinition = normalizeConfigDefinition(configDefinition)

export const configDescriptor: ConfigDescriptor = {
  groups: normalizedConfigDefinition.groups,
  fields: normalizedConfigDefinition.fields.map(({ path, groupPath, label, description, type, apply }) => ({
    path,
    groupPath,
    label,
    description,
    type,
    apply
  }))
}

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
  }
  if (config.channelo.feishu?.enabled) {
    requireValue(issues, config.channelo.feishu.appId, 'channelo.feishu.appId is required')
    requireValue(issues, config.channelo.feishu.appSecret, 'channelo.feishu.appSecret is required')
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
    requireValue(issues, nfirco.section, 'channelo.nfirco.section is required')
  }
  if (issues.length > 0) {
    throw new Error([
      'Codexio config invalid:',
      ...issues.map((issue) => `- ${issue}`)
    ].join('\n'))
  }
}

function defineConfig<T extends ConfigDefinitionMap>(definition: T): T {
  return definition
}

function group<T extends ConfigDefinitionMap>(definition: {
  title: string
  description?: string
}, fields: T): ConfigGroupDefinition<T> {
  return {
    kind: 'group',
    title: definition.title,
    description: definition.description ?? '',
    fields
  }
}

function field<S extends z.ZodTypeAny>(definition: Omit<ConfigFieldDefinition<S>, 'kind' | 'path' | 'groupPath'>): ConfigFieldDefinition<S> {
  return {
    kind: 'field',
    path: '',
    groupPath: '',
    ...definition
  }
}

function createConfigSchema(): z.ZodType<CodexioConfig> {
  return buildSchema(normalizedConfigDefinition.schemaTree) as z.ZodType<CodexioConfig>
}

function normalizeConfigDefinition(definition: ConfigDefinitionMap): {
  groups: ConfigGroupDescriptor[]
  fields: NormalizedConfigField[]
  schemaTree: ConfigObject
  defaultTree: ConfigObject
} {
  const groups: ConfigGroupDescriptor[] = []
  const fields: NormalizedConfigField[] = []
  const schemaTree: ConfigObject = {}
  const defaultTree: ConfigObject = {}
  collectConfigDefinition(definition, [], '', groups, fields, schemaTree, defaultTree)
  return {
    groups,
    fields,
    schemaTree,
    defaultTree
  }
}

function collectConfigDefinition(node: ConfigDefinitionNode, path: string[], groupPath: string, groups: ConfigGroupDescriptor[], fields: NormalizedConfigField[], schemaTree: ConfigObject, defaultTree: ConfigObject): void {
  if (isFieldDefinition(node)) {
    const fullPath = path.join('.')
    fields.push({
      ...node,
      path: fullPath,
      groupPath
    })
    setPath(schemaTree, fullPath, node.schema.default(defaultValue(node.default)))
    setPath(defaultTree, fullPath, defaultValue(node.default))
    return
  }
  if (isGroupDefinition(node)) {
    const currentGroupPath = path.join('.')
    groups.push({
      path: currentGroupPath,
      title: node.title,
      description: node.description
    })
    collectConfigDefinition(node.fields, path, currentGroupPath, groups, fields, schemaTree, defaultTree)
    return
  }
  for (const [key, child] of Object.entries(node)) {
    collectConfigDefinition(child, [...path, key], groupPath, groups, fields, schemaTree, defaultTree)
  }
}

function isFieldDefinition(value: ConfigDefinitionNode): value is ConfigFieldDefinition {
  return isPlainObject(value) && value.kind === 'field'
}

function isGroupDefinition(value: ConfigDefinitionNode): value is ConfigGroupDefinition {
  return isPlainObject(value) && value.kind === 'group'
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
  return cloneConfigObject(normalizedConfigDefinition.defaultTree)
}

function cloneConfigObject(value: unknown): ConfigObject {
  if (!isPlainObject(value)) {
    return value as ConfigObject
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    Array.isArray(item) ? [...item] : isPlainObject(item) ? cloneConfigObject(item) : item
  ]))
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
