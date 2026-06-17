import { ChannelAdapter, ChannelStartInput } from './ChannelAdapter.js'
import { Result } from '../Result.js'

export class CliChannelAdapter implements ChannelAdapter {
  readonly type = 'cli'
  readonly sent: string[] = []

  start(input: ChannelStartInput): void {
    input.app.post('/api/messages/inbound', async (request, response) => {
      try {
        if (!request.body || typeof request.body !== 'object') {
          response.json(Result.fail('inbound text not found'))
          return
        }
        const body = request.body as Record<string, unknown>
        if (typeof body.channel === 'string' && body.channel !== this.type) {
          response.json(Result.fail('inbound text not found'))
          return
        }
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
        if (result.isFailed) {
          response.json(result)
          return
        }
        response.json(result)
      } catch (error) {
        response.json(Result.fromError(error))
      }
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
    this.sent.push(text)
    process.stdout.write(`[codexio] ${text}\n`)
    return Result.success(null)
  }
}
