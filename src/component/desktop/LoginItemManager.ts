type LoginItemApplication = {
  setLoginItemSettings: (settings: {
    openAtLogin: boolean
    path: string
  }) => void
}

export class LoginItemManager {
  constructor(
    private readonly application: LoginItemApplication,
    private readonly packaged: boolean,
    private readonly platform: NodeJS.Platform,
    private readonly executablePath: string
  ) {}

  apply(startAtLogin: boolean): void {
    if (!this.packaged || this.platform !== 'win32') {
      return
    }
    this.application.setLoginItemSettings({
      openAtLogin: startAtLogin,
      path: this.executablePath
    })
  }
}
