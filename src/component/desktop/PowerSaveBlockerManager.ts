type AppSuspensionBlocker = {
  start: (type: 'prevent-app-suspension') => number
  stop: (id: number) => boolean
}

export class PowerSaveBlockerManager {
  private blockerId?: number

  constructor(private readonly blocker: AppSuspensionBlocker) {}

  apply(enabled: boolean): void {
    if (enabled) {
      if (this.blockerId === undefined) {
        this.blockerId = this.blocker.start('prevent-app-suspension')
      }
      return
    }
    this.stop()
  }

  stop(): void {
    if (this.blockerId === undefined) {
      return
    }
    const blockerId = this.blockerId
    this.blocker.stop(blockerId)
    this.blockerId = undefined
  }
}
