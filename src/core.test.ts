import { describe, expect, it } from 'vitest'
import { ConfigSchema } from './config/ConfigSchema.js'
import { OutboundPolicy } from './policy/OutboundPolicy.js'
import { Router } from './routing/Router.js'
import { EchoRuntime } from './runtime/EchoRuntime.js'
import { RuntimeManager } from './runtime/RuntimeManager.js'
import { RuntimeRegistry } from './runtime/RuntimeRegistry.js'

describe('core', () => {
  it('routes inbound text to runtime and sends outbound text through echo runtime', async () => {
    const config = ConfigSchema.parse({
      defaultAgent: 'echo',
      agents: {
        echo: {
          enabled: true,
          command: 'echo'
        }
      },
      channels: {
        web: {
          enabled: true
        }
      },
      workspaces: {
        default: {
          path: '.',
          defaultAgent: 'echo',
          allowedChannels: [
            'web'
          ]
        }
      }
    })
    const outbound: string[] = []
    const registry = new RuntimeRegistry()
    const runtimes = new Map([
      [
        'echo',
        new EchoRuntime({
          onMessage: async (_runtimeId, text) => {
            outbound.push(text)
          }
        })
      ]
    ])
    const manager = new RuntimeManager({
      config,
      registry,
      runtimes,
      env: {}
    })
    const router = new Router(config)
    const message = {
      channel: 'web',
      conversationId: 'browser',
      text: 'hello'
    }
    const context = await manager.accept(message, router.selectWorkspace(message))
    expect(context.runtimeId).toMatch(/^rt_/)
    expect(outbound).toEqual([
      'echo: hello'
    ])
  })

  it('blocks secret-like outbound text', () => {
    const config = ConfigSchema.parse({
      workspaces: {
        default: {
          path: '.'
        }
      }
    })
    const policy = new OutboundPolicy(config)
    const result = policy.check('rt_a', 'sk-123456789012345678901234')
    expect(result.isFailed).toBe(true)
  })
})
