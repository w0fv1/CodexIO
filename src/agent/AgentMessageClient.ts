import { inject, injectable } from 'inversify'
import { Configer } from '../component/Configer.js'
import { Message } from '../value/Message.js'
import { Result } from '../value/Result.js'

@injectable()
export class AgentMessageClient {
  constructor(@inject(Configer) private readonly configer: Configer) {}

  async send(message: Message): Promise<void> {
    const host = await this.configer.get('server.host')
    const port = await this.configer.get('server.port')
    const token = await this.configer.get('server.token')
    const response = await fetch(`http://${host}:${port}/api/agent/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        ioThreadId: message.ioThreadId,
        text: message.text,
        files: message.files?.map((file) => ({
          path: file.path
        })) ?? []
      })
    })
    if (!response.ok) {
      throw new Error(`agent message failed: ${response.status}`)
    }
    const result = await response.json() as Result<unknown>
    if (result.isFailed) {
      throw new Error(result.message)
    }
  }
}
