import electronUpdater from 'electron-updater'
import type { ProgressInfo, UpdateDownloadedEvent, UpdateInfo } from 'electron-updater'

const { autoUpdater } = electronUpdater

type UpdateCheckSource = 'automatic' | 'manual'

type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking'; source: UpdateCheckSource }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'ready'; version: string; downloadedFile: string }
  | { kind: 'installing'; version: string }
  | { kind: 'failed'; message: string }

type CodexioUpdaterOptions = {
  isPackaged: boolean
  currentVersion: string
  log: (message: string) => void
  notify: (title: string, body: string, onClick?: () => void) => void
  refreshMenu: () => void
  openInstaller: (file: string) => Promise<string>
  quit: () => void
}

export class CodexioUpdater {
  private readonly options: CodexioUpdaterOptions
  private state: UpdateState = { kind: 'idle' }
  private configured = false

  constructor(options: CodexioUpdaterOptions) {
    this.options = options
  }

  configure(): void {
    if (this.configured) {
      return
    }
    this.configured = true
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.on('checking-for-update', () => {
      this.options.log('updater checking')
      if (this.state.kind !== 'checking') {
        this.state = { kind: 'checking', source: 'automatic' }
        this.options.refreshMenu()
      }
      if (this.state.kind === 'checking' && this.state.source === 'manual') {
        this.options.notify('Codexio 更新', '正在检查更新。')
      }
    })
    autoUpdater.on('update-available', (info) => {
      this.handleUpdateAvailable(info)
    })
    autoUpdater.on('update-not-available', (info) => {
      this.handleUpdateNotAvailable(info)
    })
    autoUpdater.on('download-progress', (progress) => {
      this.handleDownloadProgress(progress)
    })
    autoUpdater.on('update-downloaded', (info) => {
      this.handleUpdateDownloaded(info)
    })
    autoUpdater.on('error', (error) => {
      this.handleError(error)
    })
  }

  notifyUpdatedLaunch(): void {
    if (process.argv.includes('--updated')) {
      this.options.log(`updater launched after update version=${this.options.currentVersion}`)
      this.options.notify('Codexio 已更新', `已更新到 ${this.options.currentVersion}。`)
    }
  }

  getMenuLabel(): string {
    switch (this.state.kind) {
      case 'checking':
        return '检查更新中'
      case 'available':
        return `下载更新 ${this.state.version}`
      case 'downloading':
        return `下载更新 ${Math.round(this.state.percent)}%`
      case 'ready':
        return `更新已下载 ${this.state.version}`
      case 'installing':
        return `打开安装包 ${this.state.version}`
      default:
        return '更新'
    }
  }

  handleUserAction(): void {
    switch (this.state.kind) {
      case 'ready':
        this.notifyReadyUpdate(this.state)
        return
      case 'checking':
        this.options.notify('Codexio 更新', '正在检查更新。')
        return
      case 'available':
        void this.downloadAvailableUpdate()
        return
      case 'downloading':
        this.options.notify('Codexio 更新', `正在下载 ${this.state.version}，进度 ${Math.round(this.state.percent)}%。`)
        return
      case 'installing':
        this.options.notify('Codexio 更新', `正在打开 ${this.state.version} 安装包。`)
        return
      default:
        void this.checkForUpdates('manual')
    }
  }

  async checkForUpdates(source: UpdateCheckSource = 'automatic'): Promise<void> {
    if (!this.options.isPackaged) {
      if (source === 'manual') {
        this.options.notify('Codexio 更新', '开发模式不检查更新。')
      }
      return
    }
    if (this.state.kind === 'checking' || this.state.kind === 'downloading' || this.state.kind === 'installing') {
      this.handleUserAction()
      return
    }
    if (this.state.kind === 'available') {
      this.notifyAvailableUpdate(this.state)
      return
    }
    if (this.state.kind === 'ready') {
      this.notifyReadyUpdate(this.state)
      return
    }
    this.state = { kind: 'checking', source }
    this.options.refreshMenu()
    try {
      await autoUpdater.checkForUpdates()
    } catch (error) {
      this.options.log(`updater check failed: ${formatError(error)}`)
      if (source === 'manual') {
        this.options.notify('Codexio 更新失败', normalizeErrorMessage(error))
      }
      this.state = { kind: 'failed', message: normalizeErrorMessage(error) }
      this.options.refreshMenu()
      return
    }
    if (this.state.kind === 'checking') {
      this.state = { kind: 'idle' }
      this.options.refreshMenu()
    }
  }

  private handleUpdateAvailable(info: UpdateInfo): void {
    this.options.log(`updater available version=${info.version}`)
    const state = { kind: 'available' as const, version: info.version }
    this.state = state
    this.notifyAvailableUpdate(state)
    this.options.refreshMenu()
  }

  private handleUpdateNotAvailable(info: UpdateInfo): void {
    const wasManual = this.state.kind === 'checking' && this.state.source === 'manual'
    this.options.log(`updater not available version=${info.version}`)
    this.state = { kind: 'idle' }
    if (wasManual) {
      this.options.notify('Codexio 更新', '当前已是最新版本。')
    }
    this.options.refreshMenu()
  }

  private handleDownloadProgress(progress: ProgressInfo): void {
    const percent = Number.isFinite(progress.percent) ? progress.percent : 0
    if (this.state.kind === 'downloading') {
      this.state = { ...this.state, percent }
      this.options.refreshMenu()
    }
    this.options.log(`updater download progress=${Math.round(percent)} transferred=${progress.transferred} total=${progress.total}`)
  }

  private handleUpdateDownloaded(info: UpdateDownloadedEvent): void {
    this.options.log(`updater downloaded version=${info.version} file=${info.downloadedFile}`)
    const readyState = {
      kind: 'ready' as const,
      version: info.version,
      downloadedFile: info.downloadedFile
    }
    this.state = readyState
    this.notifyReadyUpdate(readyState)
    this.options.refreshMenu()
  }

  private notifyReadyUpdate(state: Extract<UpdateState, { kind: 'ready' }>): void {
    this.options.notify('Codexio 更新已下载', `${state.version} 已下载完成，点击打开安装包。`, () => {
      void this.openReadyInstaller()
    })
  }

  private notifyAvailableUpdate(state: Extract<UpdateState, { kind: 'available' }>): void {
    this.options.notify('Codexio 发现新版本', `${state.version} 可下载，点击开始下载。`, () => {
      void this.downloadAvailableUpdate()
    })
  }

  private async downloadAvailableUpdate(): Promise<void> {
    if (this.state.kind !== 'available') {
      this.handleUserAction()
      return
    }
    const version = this.state.version
    this.options.log(`updater download requested version=${version}`)
    this.state = { kind: 'downloading', version, percent: 0 }
    this.options.refreshMenu()
    this.options.notify('Codexio 更新', `开始下载 ${version}。`)
    try {
      await autoUpdater.downloadUpdate()
    } catch (error) {
      this.handleError(error)
    }
  }

  private async openReadyInstaller(): Promise<void> {
    if (this.state.kind !== 'ready') {
      this.handleUserAction()
      return
    }
    const version = this.state.version
    const downloadedFile = this.state.downloadedFile
    this.options.log(`updater installer open requested version=${version} file=${downloadedFile}`)
    this.state = { kind: 'installing', version }
    this.options.refreshMenu()
    this.options.notify('Codexio 正在更新', `正在打开 ${version} 安装包，请按安装器提示完成更新。`)
    try {
      const message = await this.options.openInstaller(downloadedFile)
      if (message.trim().length > 0) {
        throw new Error(message)
      }
      this.options.quit()
    } catch (error) {
      this.handleError(error)
    }
  }

  private handleError(error: unknown): void {
    const message = normalizeErrorMessage(error)
    const shouldNotify = this.state.kind === 'checking'
      || this.state.kind === 'downloading'
      || this.state.kind === 'installing'
      || this.state.kind === 'ready'
    this.options.log(`updater error: ${formatError(error)}`)
    this.state = { kind: 'failed', message }
    if (shouldNotify) {
      this.options.notify('Codexio 更新失败', message)
    }
    this.options.refreshMenu()
  }
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message
  }
  return String(error)
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message
  }
  return String(error)
}
