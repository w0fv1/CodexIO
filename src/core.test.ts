import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { codexHomePath, createAgentEnv } from './agent/AgentEnvironment.js'
import { AgentManager } from './agent/AgentManager.js'
import { CodexAgent } from './agent/CodexAgent.js'
import { EchoAgent } from './agent/EchoAgent.js'
import { createEmailMessagePayload, createEmailSender, isAllowedEmailSender } from './channel/EmailChannelAdapter.js'
import { createFeishuMessagePayload } from './channel/FeishuChannelAdapter.js'
import { renderMarkdownHtml } from './channel/Markdown.js'
import { ConfigSchema, ConfigService, normalizeWorkspacePath } from './ConfigService.js'
import { Result } from './Result.js'

describe('core', () => {
  it('echo agent sends received text', async () => {
    const outbound: string[] = []
    const agent = new EchoAgent({
      send: async (text) => {
        outbound.push(text)
      }
    })
    await agent.start(ConfigSchema.parse({}))
    await agent.receive('hello')
    expect(outbound).toEqual([
      'echo: hello'
    ])
  })

  it('selected agent exposes login lifecycle', async () => {
    const manager = new AgentManager(ConfigSchema.parse({
      agents: {
        codex: {
          enabled: false
        },
        claude: {
          enabled: false
        },
        echo: {
          enabled: true
        }
      }
    }), 'http://127.0.0.1:8787', {
      send: async () => Result.success(null),
      status: async () => Result.success(null)
    })
    expect(manager.status().status).toBe('idle')
    await expect(manager.login()).resolves.toBeUndefined()
  })

  it('agents apply proxy env internally', async () => {
    const env = createAgentEnv(ConfigSchema.parse({
      proxy: {
        enabled: true,
        host: 'proxy.local',
        port: 8080
      },
      server: {
        host: '127.0.0.1',
        port: 8787
      }
    }))
    expect(env.HTTP_PROXY).toBe('http://proxy.local:8080')
    expect(env.HTTPS_PROXY).toBe('http://proxy.local:8080')
    expect(env.ALL_PROXY).toBe('socks5://proxy.local:8080')
    expect(env.NO_PROXY).toContain('127.0.0.1')
    expect(env.NO_PROXY).toContain('localhost')
    expect(env.no_proxy).toBe(env.NO_PROXY)
    expect(env.CODEX_HOME).toContain('.codexio')
    expect(env.CODEX_HOME).toContain('codex')
    expect(existsSync(codexHomePath)).toBe(true)
  })

  it('codex agent injects codexio runtime instruction', async () => {
    const requests: Array<{
      method: string
      params: unknown
    }> = []
    const agent = new CodexAgent({
      workspacePath: '.',
      config: ConfigSchema.parse({
        server: {
          token: 'test-token'
        }
      }),
      toolBaseUrl: 'http://127.0.0.1:8787',
      send: async () => {},
      appServer: {
        async start(): Promise<void> {},
        async request(method: string, params: unknown): Promise<unknown> {
          requests.push({
            method,
            params
          })
          if (method === 'account/read') {
            return {
              account: {}
            }
          }
          return {
            thread: {
              id: 'thread-1'
            }
          }
        },
        async waitForNotification(): Promise<void> {},
        async stop(): Promise<void> {}
      }
    })
    await agent.start(ConfigSchema.parse({}))
    const threadStart = requests.find((request) => request.method === 'thread/start')
    expect(threadStart?.params).toMatchObject({
      developerInstructions: expect.stringContaining('http://127.0.0.1:8787/api/message')
    })
    const developerInstructions = (threadStart?.params as Record<string, unknown>).developerInstructions
    expect(developerInstructions).toContain('Bearer test-token')
    expect(developerInstructions).not.toContain('${toolBaseUrl}')
    expect(developerInstructions).not.toContain('${token}')
  })

  it('codex agent steers the active app-server turn', async () => {
    const requests: Array<{
      method: string
      params: unknown
    }> = []
    let threadCount = 0
    const appServer = {
      async start(): Promise<void> {},
      async request(method: string, params: unknown): Promise<unknown> {
        requests.push({
          method,
          params
        })
        if (method === 'account/read') {
          return {
            account: {}
          }
        }
        if (method === 'thread/start') {
          threadCount += 1
          return {
            thread: {
              id: `thread-${threadCount}`
            }
          }
        }
        if (method === 'turn/start') {
          return {
            turn: {
              id: 'turn-1'
            }
          }
        }
        if (method === 'turn/steer') {
          return {
            turnId: 'turn-1'
          }
        }
        return {}
      },
      async waitForNotification(): Promise<void> {},
      async stop(): Promise<void> {}
    }
    const agent = new CodexAgent({
      workspacePath: '.',
      config: ConfigSchema.parse({}),
      toolBaseUrl: 'http://127.0.0.1:8787',
      send: async () => {},
      appServer
    })
    await agent.start(ConfigSchema.parse({}))
    await agent.receive('first')
    await agent.receive('second')
    await agent.clear()
    expect(requests.map((request) => request.method)).toEqual([
      'account/read',
      'thread/start',
      'turn/start',
      'turn/steer',
      'turn/interrupt',
      'thread/start'
    ])
    expect(requests[1].params).toMatchObject({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access'
    })
    expect(requests[3].params).toMatchObject({
      threadId: 'thread-1',
      expectedTurnId: 'turn-1'
    })
  })

  it('codex agent starts device-code login when account is missing', async () => {
    const outbound: string[] = []
    const requests: Array<{
      method: string
      params: unknown
    }> = []
    const appServer = {
      async start(): Promise<void> {},
      async request(method: string, params: unknown): Promise<unknown> {
        requests.push({
          method,
          params
        })
        if (method === 'account/read') {
          return {
            account: null,
            requiresOpenaiAuth: true
          }
        }
        if (method === 'account/login/start') {
          return {
            type: 'chatgptDeviceCode',
            verificationUrl: 'https://login.example.test/device',
            userCode: 'ABCD-EFGH'
          }
        }
        if (method === 'thread/start') {
          return {
            thread: {
              id: 'thread-1'
            }
          }
        }
        return {}
      },
      async waitForNotification(method: string): Promise<void> {
        expect(method).toBe('account/login/completed')
      },
      async stop(): Promise<void> {}
    }
    const agent = new CodexAgent({
      workspacePath: '.',
      config: ConfigSchema.parse({}),
      toolBaseUrl: 'http://127.0.0.1:8787',
      send: async (text) => {
        outbound.push(text)
      },
      appServer
    })
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await agent.start(ConfigSchema.parse({}))
    } finally {
      stdout.mockRestore()
    }
    expect(requests.map((request) => request.method)).toEqual([
      'account/read',
      'account/login/start',
      'thread/start'
    ])
    expect(requests[1].params).toEqual({
      type: 'chatgptDeviceCode'
    })
    expect(outbound[0]).toContain('https://login.example.test/device')
    expect(outbound[0]).toContain('ABCD-EFGH')
    expect(outbound[1]).toBe('Codex login completed.')
  })

  it('migrates old config to one enabled agent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-'))
    const path = join(dir, 'config.yaml')
    await writeFile(path, [
      'server:',
      '  host: 127.0.0.1',
      '  port: 8787',
      '  publicUrl: http://127.0.0.1:8787',
      'proxy:',
      '  enabled: true',
      '  http: http://127.0.0.1:7890',
      'defaultAgent: codex',
      'agents:',
      '  codex:',
      '    enabled: true',
      '  claude:',
      '    enabled: true',
      'workspaces:',
      '  default:',
      '    path: C:\\\\repo',
      'routing:',
      '  defaultWorkspace: default'
    ].join('\n'), 'utf8')
    const config = await new ConfigService(path).load()
    expect(config.agents.codex?.enabled).toBe(true)
    expect(config.agents.claude?.enabled).toBe(false)
    expect(config.workspace.path).toBe('C:\\\\repo')
    expect(config.proxy).toEqual({
      enabled: true,
      host: '127.0.0.1',
      port: 7890
    })
  })

  it('migrates old config selected workspace through typed legacy shape', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-'))
    const path = join(dir, 'config.yaml')
    await writeFile(path, [
      'proxy:',
      '  enabled: true',
      '  http: http://proxy.local:8080',
      'defaultAgent: echo',
      'workspaces:',
      '  default:',
      '    path: C:\\\\default',
      '  product:',
      '    path: C:\\\\product',
      'routing:',
      '  defaultWorkspace: product'
    ].join('\n'), 'utf8')
    const config = await new ConfigService(path).load()
    expect(config.agents.echo?.enabled).toBe(true)
    expect(config.agents.codex?.enabled).toBe(false)
    expect(config.agents.claude?.enabled).toBe(false)
    expect(config.workspace.path).toBe('C:\\\\product')
    expect(config.proxy).toEqual({
      enabled: true,
      host: 'proxy.local',
      port: 8080
    })
  })

  it('defaults workspace to codexio local workspace directory', () => {
    const config = new ConfigService().createDefaultConfig()
    expect(config.workspace.path).toContain(join('.codexio', 'workspace'))
  })

  it('expands home workspace paths', () => {
    expect(normalizeWorkspacePath('~/Desktop')).toBe(join(homedir(), 'Desktop'))
  })

  it('resolves config references before final schema validation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-'))
    const path = join(dir, 'config.yaml')
    const previousToken = process.env.CODEXIO_TEST_TOKEN
    process.env.CODEXIO_TEST_TOKEN = 'env-token'
    await writeFile(path, [
      'server:',
      '  token: ${CODEXIO_TEST_TOKEN}',
      'proxy:',
      '  enabled: true',
      '  host: proxy.local',
      '  port: 8080',
      'workspace:',
      '  path: ${proxy.host}'
    ].join('\n'), 'utf8')
    try {
      const config = await new ConfigService(path).load()
      expect(config.server.token).toBe('env-token')
      expect(config.workspace.path).toBe(normalizeWorkspacePath('proxy.local'))
    } finally {
      if (previousToken === undefined) {
        delete process.env.CODEXIO_TEST_TOKEN
      } else {
        process.env.CODEXIO_TEST_TOKEN = previousToken
      }
    }
  })

  it('loads channel credentials from config', () => {
    const config = ConfigSchema.parse({
      channels: {
        feishu: {
          enabled: true,
          appId: 'cli_test',
          appSecret: 'secret_test',
          chatId: 'oc_test'
        },
        feishuWebhook: {
          enabled: true,
          url: 'https://open.feishu.cn/webhook/test'
        },
        email: {
          enabled: true,
          user: 'target@example.test',
          agent: {
            imap: {
              host: 'imap.example.test',
              port: 993,
              secure: true,
              user: 'agent@example.test',
              password: 'imap-password',
              mailbox: 'INBOX'
            },
            smtp: {
              host: 'smtp.example.test',
              port: 465,
              secure: true,
              user: 'agent@example.test',
              password: 'smtp-password',
              from: 'agent@example.test'
            }
          }
        }
      }
    })
    expect(config.channels.feishu?.enabled).toBe(true)
    expect(config.channels.feishu?.appId).toBe('cli_test')
    expect(config.channels.feishu?.appSecret).toBe('secret_test')
    expect(config.channels.feishu?.chatId).toBe('oc_test')
    expect(config.channels.feishuWebhook?.url).toBe('https://open.feishu.cn/webhook/test')
    expect(config.channels.email?.user).toBe('target@example.test')
    expect(config.channels.email?.agent.imap.host).toBe('imap.example.test')
    expect(config.channels.email?.agent.smtp.host).toBe('smtp.example.test')
  })

  it('migrates legacy email config to user and agent mailbox', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-'))
    const path = join(dir, 'config.yaml')
    await writeFile(path, [
      'channels:',
      '  email:',
      '    enabled: true',
      '    imap:',
      '      host: imap.example.test',
      '      port: 993',
      '      secure: true',
      '      user: agent@example.test',
      '      password: imap-password',
      '      mailbox: INBOX',
      '    smtp:',
      '      host: smtp.example.test',
      '      port: 465',
      '      secure: true',
      '      user: agent@example.test',
      '      password: smtp-password',
      '      from: agent@example.test',
      '    to:',
      '      - target@example.test'
    ].join('\n'), 'utf8')
    const config = await new ConfigService(path).load()
    expect(config.channels.email?.user).toBe('target@example.test')
    expect(config.channels.email?.agent.imap.user).toBe('agent@example.test')
    expect(config.channels.email?.agent.smtp.user).toBe('agent@example.test')
  })

  it('uses smtp user as email address when sender is only a display name', () => {
    expect(createEmailSender('codexio-w0fv1', 'codexio-w0fv1@laiqi.club')).toEqual({
      name: 'codexio-w0fv1',
      address: 'codexio-w0fv1@laiqi.club'
    })
  })

  it('filters incoming email by configured user address', () => {
    expect(isAllowedEmailSender([
      'WOFBI1@OUTLOOK.COM'
    ], 'wofbi1@outlook.com')).toBe(true)
    expect(isAllowedEmailSender([
      'other@example.test'
    ], 'wofbi1@outlook.com')).toBe(false)
  })

  it('formats feishu message without codexio title and labels user at bottom', () => {
    const agentPayload = createFeishuMessagePayload({
      role: 'agent',
      text: 'agent output',
      createdAt: Date.now()
    })
    const agentContent = JSON.parse(agentPayload.content) as {
      zh_cn: {
        title?: string
        content: Array<Array<{ tag: string, text: string }>>
      }
    }
    expect(agentContent.zh_cn.title).toBeUndefined()
    expect(agentContent.zh_cn.content).toEqual([
      [
        {
          tag: 'md',
          text: 'agent output'
        }
      ]
    ])

    const userPayload = createFeishuMessagePayload({
      role: 'user',
      text: 'user input',
      createdAt: Date.now()
    })
    const userContent = JSON.parse(userPayload.content) as {
      zh_cn: {
        content: Array<Array<{ tag: string, text: string }>>
      }
    }
    expect(userContent.zh_cn.content.at(-1)).toEqual([
      {
        tag: 'text',
        text: 'User'
      }
    ])
  })

  it('formats email message without codexio title and labels user at bottom', () => {
    const agentPayload = createEmailMessagePayload({
      role: 'agent',
      text: 'agent output',
      createdAt: Date.now()
    })
    expect(agentPayload).toEqual({
      subject: 'Agent',
      text: 'agent output'
    })

    const userPayload = createEmailMessagePayload({
      role: 'user',
      text: 'user input',
      createdAt: Date.now()
    })
    expect(userPayload).toEqual({
      subject: 'User',
      text: 'user input\n\nUser'
    })
  })

  it('renders safe markdown for web channel display', () => {
    const html = renderMarkdownHtml([
      '**bold**',
      '',
      '```ts',
      'const value = 1',
      '```',
      '',
      '<script>alert(1)</script>'
    ].join('\n'))
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<code>const value = 1')
    expect(html).not.toContain('<script>')
  })
})
