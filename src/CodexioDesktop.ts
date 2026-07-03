import { spawn, ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
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

const { app, Menu, nativeImage, shell, Tray } = electron
const { autoUpdater } = electronUpdater
const iconPath = 'assets/icon.png'

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
    this.createTray()
    this.startServer()
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
        label: '检查更新',
        click: () => {
          void this.checkForUpdates()
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
    })
    autoUpdater.on('update-available', (info) => {
      this.log(`updater available version=${info.version}`)
    })
    autoUpdater.on('update-not-available', (info) => {
      this.log(`updater not available version=${info.version}`)
    })
    autoUpdater.on('download-progress', (progress) => {
      this.log(`updater download progress=${Math.round(progress.percent)} transferred=${progress.transferred} total=${progress.total}`)
    })
    autoUpdater.on('update-downloaded', (info) => {
      this.log(`updater downloaded version=${info.version}`)
    })
    autoUpdater.on('error', (error) => {
      this.log(`updater error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    })
  }

  private async checkForUpdates(): Promise<void> {
    if (!app.isPackaged || this.checkingUpdate) {
      return
    }
    this.checkingUpdate = true
    try {
      await autoUpdater.checkForUpdates()
    } catch (error) {
      this.log(`updater check failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
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
  }

  private async scheduleServerRestart(): Promise<void> {
    const uptime = Date.now() - this.serverStartedAt
    this.serverFailures = uptime > 30_000 ? 0 : this.serverFailures + 1
    const delay = Math.min(30_000, 1000 * 2 ** Math.max(0, this.serverFailures - 1))
    this.log(`server restarting in ${delay}ms`)
    await wait(delay)
    if (!this.quitting && !this.restarting) {
      this.startServer()
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

void new CodexioDesktop().start().catch((error) => {
  try {
    const basePath = app.isReady() ? app.getPath('userData') : process.cwd()
    const logPath = join(basePath, 'log', 'desktop.log')
    appendFileSync(logPath, `${new Date().toISOString()} desktop failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`, 'utf8')
  } catch {
  }
  app.quit()
})
