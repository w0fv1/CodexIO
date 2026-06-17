import { EventEmitter } from 'node:events'
import { ChannelAdapter, ChannelStartInput } from './ChannelAdapter.js'
import { webPageHtml } from './WebPage.js'
import { Result } from '../Result.js'

export type WebOutboundMessage = {
  text: string
  createdAt: number
}

export class WebChannelAdapter implements ChannelAdapter {
  readonly type = 'web'
  private readonly emitter = new EventEmitter()
  private messages: WebOutboundMessage[] = []

  start(input: ChannelStartInput): void {
    input.app.get('/', (_request, response) => {
      response.type('html').send(webPageHtml)
    })
    input.app.post('/api/web/messages', async (request, response) => {
      try {
        if (!request.body || typeof request.body !== 'object') {
          response.json(Result.fail('inbound text not found'))
          return
        }
        const body = request.body as Record<string, unknown>
        if (typeof body.text !== 'string' || body.text.trim().length === 0) {
          response.json(Result.fail('inbound text not found'))
          return
        }
        const text = body.text
        const received = await this.receive(text)
        if (received.isFailed) {
          response.json(received)
          return
        }
        const result = await input.receive({
          channel: this.type,
          text
        })
        if (result.data?.action === 'clear') {
          this.messages = []
        }
        response.json(result)
      } catch (error) {
        response.json(Result.fromError(error))
      }
    })
    input.app.get('/api/web/events', (request, response) => {
      response.setHeader('Content-Type', 'text/event-stream')
      response.setHeader('Cache-Control', 'no-cache')
      response.setHeader('Connection', 'keep-alive')
      for (const message of this.messages) {
        response.write(`data: ${JSON.stringify(message)}\n\n`)
      }
      const listener = (message: WebOutboundMessage) => {
        response.write(`data: ${JSON.stringify(message)}\n\n`)
      }
      this.emitter.on('message', listener)
      request.on('close', () => {
        this.emitter.off('message', listener)
      })
    })
  }

  async receive(text: string): Promise<Result<null>> {
    if (text.trim().length === 0) {
      return Result.fail('text is required')
    }
    return Result.success(null)
  }

  async send(text: string): Promise<Result<null>> {
    if (text.trim().length === 0) {
      return Result.fail('text is required')
    }
    const message = {
      text,
      createdAt: Date.now()
    }
    this.messages.push(message)
    this.emitter.emit('message', message)
    return Result.success(null)
  }

}
