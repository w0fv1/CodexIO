import { readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { createAgentEnv } from './agent/AgentEnvironment.js'
import { CodexAgent } from './agent/CodexAgent.js'
import { EchoAgent } from './agent/EchoAgent.js'
import { ConfigSchema, ConfigService } from './ConfigService.js'
import { createAgent } from './index.js'

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
    const agent = createAgent(ConfigSchema.parse({
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
    }), 'http://127.0.0.1:8787', async () => {})
    expect(agent).toBeInstanceOf(EchoAgent)
    await expect(agent.login()).resolves.toBeUndefined()
  })

  it('agents apply proxy env internally', async () => {
    const codexHome = resolve('.codexio', 'codex')
    await rm(codexHome, {
      recursive: true,
      force: true
    })
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
    expect(existsSync(codexHome)).toBe(true)
  })

  it('codex agent installs an HTTP-only Codexio skill', async () => {
    const agent = new CodexAgent({
      workspacePath: '.',
      config: ConfigSchema.parse({}),
      toolBaseUrl: 'http://127.0.0.1:8787',
      send: async () => {},
      appServer: {
        async start(): Promise<void> {},
        async request(method: string): Promise<unknown> {
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
    const text = await readFile(resolve('.codexio', 'codex', 'skills', 'codexio', 'SKILL.md'), 'utf8')
    expect(text).toContain('/api/message')
    expect(text).not.toContain('send_message({ text })')
    expect(text).not.toContain('communication tool')
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
})
