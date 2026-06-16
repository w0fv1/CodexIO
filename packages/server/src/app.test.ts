import { describe, expect, it } from 'vitest'
import { ConfigSchema } from '@codexio/core'
import { createCodexioApp } from './app.js'

describe('server', () => {
  it('receives web message and exposes outbound message', async () => {
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
    const server = createCodexioApp(config)
    const listener = server.app.listen(0)
    await new Promise<void>((resolve) => {
      listener.once('listening', resolve)
    })
    const address = listener.address()
    if (!address || typeof address === 'string') {
      throw new Error('server address not found')
    }
    const baseUrl = `http://127.0.0.1:${address.port}`
    const inboundResponse = await fetch(`${baseUrl}/api/web/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        conversationId: 'browser',
        text: 'hello'
      })
    })
    const inbound = await inboundResponse.json() as {
      data: {
        runtimeId: string
      }
      isFailed: boolean
    }
    expect(inbound.isFailed).toBe(false)
    expect(inbound.data.runtimeId).toMatch(/^rt_/)
    const messagesResponse = await fetch(`${baseUrl}/api/web/messages/browser`)
    const messages = await messagesResponse.json() as {
      data: Array<{
        text: string
      }>
    }
    expect(messages.data.map((item) => item.text)).toEqual([
      'echo: hello'
    ])
    await new Promise<void>((resolve, reject) => {
      listener.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
  })
})
