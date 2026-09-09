import { renderConfigTemplate } from '../src/value/ConfigTemplate.js'
import { describe, expect, it } from 'vitest'
import { configDescriptor, ConfigSchema, createDefaultConfig, parseCodexioConfig, validateCodexioConfig } from '../src/value/ConfigDefinition.js'

describe('configuration contract', () => {
  it('creates channel-only default config', () => {
    const config = createDefaultConfig()
    expect(config.app.id).toBe('')
    expect(config.app.startAtLogin).toBe(false)
    expect(config.app.preventSystemSleep).toBe(true)
    expect(config.server.host).toBe('127.0.0.1')
    expect(config.agents.instruction).toContain('Markdown reference')
    expect(config.agents.instruction).toContain('previews without a file path')
    expect(config.agents.echo.enabled).toBe(true)
    expect(config.agents.codex.bundled).toBe(true)
    expect(config.app.workspace.path).toBe('workspace')
    expect(config.proxy.host).toBe('127.0.0.1')
    expect(config.proxy.noProxy).toBe('')
    expect(config.channeli.web?.enabled).toBe(true)
    expect(config.channeli.feishu?.aite).toBe(true)
    expect(config.channeli.feishu?.allowedOpenIds).toEqual([])
    expect(config.channeli.userver?.enabled).toBe(false)
    expect(config.channelo.web?.enabled).toBe(true)
  })

  it('describes config groups by stable paths', () => {
    const feishuInput = configDescriptor.groups.find((group) => group.path === 'channeli.feishu')
    expect(feishuInput).toEqual({
      path: 'channeli.feishu',
      title: 'Feishu Input',
      description: '在已经引入 Codexio 的飞书群聊中，或与 Codexio 私聊时，输入 $bind ${app.id} 即可在飞书中绑定 Codexio。'
    })
    expect(configDescriptor.fields.find((field) => field.path === 'channeli.feishu.enabled')?.groupPath).toBe('channeli.feishu')
    expect(configDescriptor.fields.find((field) => field.path === 'app.preventSystemSleep')).toEqual(expect.objectContaining({
      groupPath: 'app',
      label: '阻止系统睡眠',
      type: 'boolean',
      apply: '立即生效'
    }))
  })

  it('does not expose cross-client Codex thread observation', () => {
    const config = createDefaultConfig()
    expect(config.agents.codex).not.toHaveProperty('observe')
    expect(configDescriptor.groups).not.toContainEqual(expect.objectContaining({
      path: 'agents.codex.observe'
    }))
    expect(configDescriptor.fields.some((field) => field.path.startsWith('agents.codex.observe.'))).toBe(false)
  })

  it('parses empty feishu chat ids as unbound strings', async () => {
    const config = await parseCodexioConfig({
      channeli: {
        feishu: {
          chatId: null
        }
      },
      channelo: {
        feishu: {
          chatId: null
        }
      }
    }, 'config.yaml')
    expect(config.channeli.feishu.chatId).toBe('')
    expect(config.channelo.feishu.chatId).toBe('')
  })

  it('rejects configs without enabled channel input and output', () => {
    const config = ConfigSchema.parse({
      channeli: {
        web: {
          enabled: false
        }
      },
      channelo: {
        web: {
          enabled: false
        }
      }
    })
    expect(() => validateCodexioConfig(config)).toThrow('one channeli must be enabled')
    expect(() => validateCodexioConfig(config)).toThrow('one channelo must be enabled')
  })

  it('rejects configs without enabled agents', () => {
    const config = ConfigSchema.parse({
      agents: {
        echo: {
          enabled: false
        },
        codex: {
          enabled: false
        }
      }
    })
    expect(() => validateCodexioConfig(config)).toThrow('one agent must be enabled')
  })
  it('renders config references without interpreting markup', () => {
    expect(renderConfigTemplate('绑定 $bind ${app.id} 到 ${server.host}', {
      app: {
        id: '<script>alert(1)</script>'
      },
      server: {
        host: '127.0.0.1'
      }
    })).toBe('绑定 $bind <script>alert(1)</script> 到 127.0.0.1')
    expect(renderConfigTemplate('保留 ${missing.value}', {})).toBe('保留 ${missing.value}')
  })
})
