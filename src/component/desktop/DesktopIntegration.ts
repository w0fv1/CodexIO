import { randomUUID } from 'node:crypto'
import { inject, injectable } from 'inversify'
import { Configer } from '../Configer.js'
import { DesktopRequest, DesktopSettingCommand, isDesktopResponse } from '../../value/DesktopMessage.js'

const desktopSettings = [
  {
    path: 'app.startAtLogin',
    command: 'setStartAtLogin'
  },
  {
    path: 'app.preventSystemSleep',
    command: 'setPreventSystemSleep'
  }
] as const

@injectable()
export class DesktopIntegration {
  constructor(@inject(Configer) private readonly configer: Configer) {}

  async start(): Promise<void> {
    for (const setting of desktopSettings) {
      await requestDesktopSetting(setting.command, await this.configer.get(setting.path))
      this.configer.beforeChange(setting.path, async ({ currentValue }) => {
        await requestDesktopSetting(setting.command, currentValue)
      })
    }
  }
}

export async function requestDesktopSetting(command: DesktopSettingCommand, value: boolean): Promise<void> {
  if (!process.send) {
    return
  }
  const request: DesktopRequest = {
    type: 'desktop.request',
    id: randomUUID(),
    command,
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
