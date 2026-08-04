import { spawn, ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import electron from 'electron'
import type { NativeImage, Tray as ElectronTray } from 'electron'
import { CodexioUpdater } from './CodexioUpdater.js'
import { DesktopLogExporter } from './component/desktop/DesktopLogExporter.js'
import { LoginItemManager } from './component/desktop/LoginItemManager.js'
import { PowerSaveBlockerManager } from './component/desktop/PowerSaveBlockerManager.js'
import { DesktopResponse, isDesktopRequest } from './value/DesktopMessage.js'

type ServerState = {
  pid: number
  host: string
  port: number
}

type MenuIconName = 'message' | 'settings' | 'refresh' | 'fileText' | 'download' | 'power'

const { app, clipboard, Menu, nativeImage, powerSaveBlocker, shell, Tray, Notification } = electron
const iconPath = 'assets/icon.png'

class CodexioDesktop {
  private tray?: ElectronTray
  private server?: ChildProcess
  private updater?: CodexioUpdater
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
  private serverFailureNotified = false
  private readonly loginItems = new LoginItemManager(app, app.isPackaged, process.platform, process.execPath)
  private readonly logExporter = new DesktopLogExporter(clipboard)
  private readonly powerSaveBlockers = new PowerSaveBlockerManager(powerSaveBlocker)
  private readonly notifications = new Set<electron.Notification>()

  async start(): Promise<void> {
    await app.whenReady()
    this.appRoot = app.getAppPath()
    app.setAppUserModelId('dev.w0fv1.codexio')
    this.dataRoot = app.getPath('userData')
    this.configPath = join(this.dataRoot, 'config.yaml')
    this.logPath = join(this.dataRoot, 'log', 'desktop.log')
    this.serverPath = join(this.appRoot, 'dist', 'CodexioApplication.js')
    await mkdir(dirname(this.logPath), {
      recursive: true
    })
    this.log('desktop starting')
    this.updater = new CodexioUpdater({
      isPackaged: app.isPackaged,
      currentVersion: app.getVersion(),
      log: (message) => {
        this.log(message)
      },
      notify: (title, body, onClick) => {
        this.notify(title, body, onClick)
      },
      refreshMenu: () => {
        this.updateMenu()
      },
      openInstaller: async (file) => shell.openPath(file),
      quit: () => {
        this.quitting = true
        this.stopServer()
        app.quit()
      }
    })
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
    this.updater.notifyUpdatedLaunch()
    this.startServer()
    void this.notifyServerReady('启动成功')
    this.updater.configure()
    void this.updater.checkForUpdates()
    if (process.argv.includes('--open')) {
      void this.openChat()
    }
    app.on('before-quit', () => {
      this.quitting = true
      this.powerSaveBlockers.stop()
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
        icon: createMenuIcon('message'),
        click: () => {
          void this.openChat()
        }
      },
      {
        label: '配置',
        icon: createMenuIcon('settings'),
        click: () => {
          void this.openConfig()
        }
      },
      {
        label: '重启',
        icon: createMenuIcon('refresh'),
        click: () => {
          void this.restartServer()
        }
      },
      {
        label: '日志',
        icon: createMenuIcon('fileText'),
        click: () => {
          void this.exportLog()
        }
      },
      {
        label: this.updater?.getMenuLabel() ?? '更新',
        icon: createMenuIcon('download'),
        click: () => {
          this.updater?.handleUserAction()
        }
      },
      {
        type: 'separator'
      },
      {
        label: '退出',
        icon: createMenuIcon('power'),
        click: () => {
          this.quitting = true
          this.stopServer()
          app.quit()
        }
      }
    ]))
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
        'pipe',
        'ipc'
      ],
      windowsHide: true
    })
    if (!this.server.pid) {
      throw new Error('Codexio server pid not found')
    }
    this.statePath = join(this.dataRoot, 'state', `server-${this.server.pid}.json`)
    this.server.on('message', (message) => {
      if (!isDesktopRequest(message)) {
        return
      }
      const response: DesktopResponse = {
        type: 'desktop.response',
        id: message.id
      }
      try {
        switch (message.command) {
          case 'setStartAtLogin':
            this.loginItems.apply(message.value)
            break
          case 'setPreventSystemSleep':
            this.powerSaveBlockers.apply(message.value)
            break
          default: {
            const unsupportedCommand: never = message.command
            throw new Error(`unsupported desktop setting command: ${unsupportedCommand}`)
          }
        }
      } catch (error) {
        response.error = normalizeErrorMessage(error)
      }
      this.server?.send?.(response)
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

  private async exportLog(): Promise<void> {
    const logDir = dirname(this.logPath)
    void shell.openPath(logDir)
    const date = new Date()
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const logFileName = `${year}-${month}-${day}.log`
    const sourcePath = join(logDir, logFileName)
    if (!existsSync(sourcePath)) {
      this.notify('Codexio 日志不存在', `没有找到今日日志 ${logFileName}`)
      return
    }
    const targetPath = join(app.getPath('downloads'), logFileName)
    try {
      await this.logExporter.export(sourcePath, targetPath)
      this.notify('Codexio 日志已导出', `已保存到 Downloads\\${logFileName}，并复制到剪贴板`)
    } catch (error) {
      this.log(`export log failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      this.notify('Codexio 日志导出失败', normalizeErrorMessage(error))
    }
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
    this.notifications.add(notification)
    notification.once('close', () => {
      this.notifications.delete(notification)
    })
    notification.once('failed', () => {
      this.notifications.delete(notification)
    })
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

function createMenuIcon(name: MenuIconName): NativeImage {
  const paths: Record<MenuIconName, string> = {
    message: '<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/><path d="M8 9h8"/><path d="M8 13h5"/>',
    settings: '<path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5z"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1A2 2 0 1 1 4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7A2 2 0 1 1 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 .9-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 1 1 19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.6.9h.1a2 2 0 1 1 0 4H21a1.7 1.7 0 0 0-1.6 1z"/>',
    refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2"/><path d="M3 12A9 9 0 0 1 18.5 5.8"/><path d="M3 17v4h4"/><path d="M21 7V3h-4"/>',
    fileText: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h8"/><path d="M8 9h2"/>',
    download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
    power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>'
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#111827" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  return nativeImage.createFromDataURL(dataUrl)
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
