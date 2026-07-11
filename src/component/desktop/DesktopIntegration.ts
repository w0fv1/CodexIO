import { randomUUID } from 'node:crypto'
import { inject, injectable } from 'inversify'
import { Configer } from '../Configer.js'
import { DesktopRequest, isDesktopResponse } from '../../value/DesktopMessage.js'

@injectable()
export class DesktopIntegration {
  constructor(@inject(Configer) private readonly configer: Configer) {}

  async start(): Promise<void> {
    await requestStartAtLogin(await this.configer.get('app.startAtLogin'))
    this.configer.beforeChange('app.startAtLogin', async ({ currentValue }) => {
      await requestStartAtLogin(currentValue)
    })
  }
}

export async function requestStartAtLogin(value: boolean): Promise<void> {
  if (!process.send) {
    return
  }
  const request: DesktopRequest = {
    type: 'desktop.request',
    id: randomUUID(),
    command: 'setStartAtLogin',
    value
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      process.off('message', receive)
      reject(new Error('desktop settings request timed out'))
    }, 5000)
    const receive = (message: unknown) => {
      if (!isDesktopResponse(message) || message.id !== request.id) {
        return
      }
      clearTimeout(timeout)
      process.off('message', receive)
      if (message.error) {
        reject(new Error(message.error))
        return
      }
      resolve()
    }
    process.on('message', receive)
    process.send?.(request, (error) => {
      if (!error) {
        return
      }
      clearTimeout(timeout)
      process.off('message', receive)
      reject(error)
    })
  })
}
