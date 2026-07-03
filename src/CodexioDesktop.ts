import { spawn, ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import electron from 'electron'
import type { NativeImage, Tray as ElectronTray } from 'electron'
import electronUpdater from 'electron-updater'

type ServerState = {
  pid: number
  host: string
  port: number
}

const { app, Menu, nativeImage, shell, Tray, Notification } = electron
const { autoUpdater } = electronUpdater
const iconPath = 'assets/icon.png'
type UpdateCheckSource = 'automatic' | 'manual'

class CodexioDesktop {
  private tray?: ElectronTray
  private server?: ChildProcess
  private quitting = false
  private restarting = false
  private serverStartedAt = 0
  private serverFailures = 0
  private appRoot = ''
  private dataRoot = ''
  private configPath = ''
  private logPath = ''
  private statePath = ''
  private serverPath = ''
  private checkingUpdate = false
  private updateCheckSource: UpdateCheckSource = 'automatic'
  private updateDownloadStarted = false
  private serverFailureNotified = false

  async start(): Promise<void> {
    await app.whenReady()
    this.appRoot = app.getAppPath()
    app.setAppUserModelId('dev.w0fv1.codexio')
    this.dataRoot = app.isPackaged ? join(dirname(process.execPath), 'data') : app.getPath('userData')
    this.configPath = join(this.dataRoot, 'config.yaml')
    this.logPath = join(this.dataRoot, 'log', 'desktop.log')
    this.statePath = join(this.dataRoot, 'state', 'server.json')
    this.serverPath = join(this.appRoot, 'dist', 'CodexioApplication.js')
    await mkdir(dirname(this.logPath), {
      recursive: true
    })
    this.log('desktop starting')
    if (!app.requestSingleInstanceLock()) {
      this.log('single instance lock rejected')
      app.quit()
      return
    }
    app.on('second-instance', () => {
      this.log('second instance requested')
      void this.openChat()
    })
    await mkdir(dirname(this.configPath), {
      recursive: true
    })
    await rm(this.statePath, {
      force: true
    })
    this.createTray()
    this.startServer()
    void this.notifyServerReady('启动成功')
    this.configureUpdater()
    void this.checkForUpdates()
    if (process.argv.includes('--open')) {
      void this.openChat()
    }
    app.on('before-quit', () => {
      this.quitting = true
      this.stopServer()
    })
  }

  private createTray(): void {
    this.tray = new Tray(createTrayIcon(this.appRoot))
    this.tray.setToolTip('Codexio')
    this.tray.on('double-click', () => {
      void this.openChat()
    })
    this.updateMenu()
  }

  private updateMenu(): void {
    this.tray?.setContextMenu(Menu.buildFromTemplate([
      {
        label: '对话',
        click: () => {
          void this.openChat()
        }
      },
      {
        label: '配置',
        click: () => {
          void this.openConfig()
        }
      },
      {
        label: '重启',
        click: () => {
          void this.restartServer()
        }
      },
      {
        label: '更新',
        click: () => {
          void this.checkForUpdates('manual')
        }
      },
      {
        type: 'separator'
      },
      {
        label: '退出',
        click: () => {
          this.quitting = true
          this.stopServer()
          app.quit()
        }
      }
    ]))
  }

  private configureUpdater(): void {
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('checking-for-update', () => {
      this.log('updater checking')
      if (this.updateCheckSource === 'manual') {
        this.notify('Codexio 更新', '正在检查更新...')
      }
    })
    autoUpdater.on('update-available', (info) => {
      this.log(`updater available version=${info.version}`)
      this.updateDownloadStarted = true
      this.notify('Codexio 更新', `发现新版本 ${info.version}，正在下载。`)
    })
    autoUpdater.on('update-not-available', (info) => {
      this.log(`updater not available version=${info.version}`)
      if (this.updateCheckSource === 'manual') {
        this.notify('Codexio 更新', '当前已是最新版本。')
      }
    })
    autoUpdater.on('download-progress', (progress) => {
      this.log(`updater download progress=${Math.round(progress.percent)} transferred=${progress.transferred} total=${progress.total}`)
    })
    autoUpdater.on('update-downloaded', (info) => {
      this.log(`updater downloaded version=${info.version}`)
      this.notify('Codexio 更新已下载', `版本 ${info.version} 已准备好，退出后会自动安装。点击立即重启安装。`, () => {
        autoUpdater.quitAndInstall()
      })
      this.updateDownloadStarted = false
    })
    autoUpdater.on('error', (error) => {
      this.log(`updater error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      if (this.updateCheckSource === 'manual' || this.updateDownloadStarted) {
        this.notify('Codexio 更新失败', normalizeErrorMessage(error))
      }
      this.updateDownloadStarted = false
    })
  }

  private async checkForUpdates(source: UpdateCheckSource = 'automatic'): Promise<void> {
    if (!app.isPackaged || this.checkingUpdate) {
      if (source === 'manual') {
        this.notify('Codexio 更新', app.isPackaged ? '正在检查更新...' : '开发模式不检查更新。')
      }
      return
    }
    this.checkingUpdate = true
    this.updateCheckSource = source
    try {
      await autoUpdater.checkForUpdates()
    } catch (error) {
      this.log(`updater check failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      if (source === 'manual') {
        this.notify('Codexio 更新失败', normalizeErrorMessage(error))
      }
    } finally {
      this.checkingUpdate = false
    }
  }

  private startServer(): void {
    if (this.server && !this.server.killed) {
      return
    }
    this.log(`server starting: ${this.serverPath}`)
    this.serverStartedAt = Date.now()
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1'
    }
    this.server = spawn(process.execPath, [
      this.serverPath,
      '--config',
      this.configPath,
      '--auto-port'
    ], {
      cwd: dirname(process.execPath),
      env,
      stdio: [
        'ignore',
        'pipe',
        'pipe'
      ],
      windowsHide: true
    })
    this.server.stdout?.on('data', (data) => {
      this.log(`server stdout: ${data.toString('utf8').trimEnd()}`)
    })
    this.server.stderr?.on('data', (data) => {
      this.log(`server stderr: ${data.toString('utf8').trimEnd()}`)
    })
    this.server.once('error', (error) => {
      this.log(`server spawn failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      this.notify('Codexio 服务启动失败', normalizeErrorMessage(error), () => {
        void shell.openPath(dirname(this.logPath))
      })
    })
    this.server.once('exit', (code, signal) => {
      this.log(`server exited code=${code ?? ''} signal=${signal ?? ''}`)
      this.server = undefined
      if (!this.quitting && !this.restarting) {
        void this.scheduleServerRestart()
      }
    })
  }

  private stopServer(): void {
    const server = this.server
    this.server = undefined
    if (!server || server.killed) {
      return
    }
    this.log('server stopping')
    server.kill()
  }

  private async restartServer(): Promise<void> {
    this.restarting = true
    this.stopServer()
    await wait(500)
    this.serverFailures = 0
    this.restarting = false
    this.startServer()
    void this.notifyServerReady('重启成功')
  }

  private async scheduleServerRestart(): Promise<void> {
    const uptime = Date.now() - this.serverStartedAt
    this.serverFailures = uptime > 30_000 ? 0 : this.serverFailures + 1
    const delay = Math.min(30_000, 1000 * 2 ** Math.max(0, this.serverFailures - 1))
    this.log(`server restarting in ${delay}ms`)
    if (this.serverFailures >= 3 && !this.serverFailureNotified) {
      this.serverFailureNotified = true
      this.notify('Codexio 服务反复退出', '请查看日志或检查配置。点击打开日志目录。', () => {
        void shell.openPath(dirname(this.logPath))
      })
    }
    await wait(delay)
    if (!this.quitting && !this.restarting) {
      this.startServer()
      void this.notifyServerReady('服务已恢复')
    }
  }

  private async openChat(): Promise<void> {
    await shell.openExternal(await this.resolveUrl('/'))
  }

  private async openConfig(): Promise<void> {
    await shell.openExternal(await this.resolveUrl('/config'))
  }

  private async resolveUrl(path: string): Promise<string> {
    this.startServer()
    const state = await this.readServerState()
    return `http://${state.host}:${state.port}${path}`
  }

  private async readServerState(): Promise<ServerState> {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (existsSync(this.statePath)) {
        const state = JSON.parse(await readFile(this.statePath, 'utf8')) as ServerState
        if (typeof state.host === 'string' && typeof state.port === 'number') {
          return state
        }
      }
      await wait(250)
    }
    throw new Error('Codexio server did not start')
  }

  private async notifyServerReady(message: string): Promise<void> {
    try {
      const state = await this.readServerState()
      this.serverFailureNotified = false
      this.log(`server ready pid=${state.pid} url=http://${state.host}:${state.port}`)
      this.notify('Codexio ' + message, `服务运行在 ${state.host}:${state.port}`)
    } catch (error) {
      this.log(`server ready wait failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      this.notify('Codexio 服务启动失败', normalizeErrorMessage(error), () => {
        void shell.openPath(dirname(this.logPath))
      })
    }
  }

  private notify(title: string, body: string, onClick?: () => void): void {
    if (!Notification.isSupported()) {
      this.log(`notification unsupported title=${title} body=${body}`)
      return
    }
    const notification = new Notification({
      title,
      body,
      icon: join(this.appRoot, iconPath)
    })
    if (onClick) {
      notification.on('click', onClick)
    }
    notification.show()
  }

  private log(message: string): void {
    try {
      appendFileSync(this.logPath, `${new Date().toISOString()} ${message}\n`, 'utf8')
    } catch {
    }
  }
}

function createTrayIcon(appRoot: string): NativeImage {
  return nativeImage.createFromPath(join(appRoot, iconPath))
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message
  }
  return String(error)
}

void new CodexioDesktop().start().catch((error) => {
  try {
    const basePath = app.isReady() ? app.getPath('userData') : process.cwd()
    const logPath = join(basePath, 'log', 'desktop.log')
    appendFileSync(logPath, `${new Date().toISOString()} desktop failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`, 'utf8')
  } catch {
  }
  app.quit()
})
