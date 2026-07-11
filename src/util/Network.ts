import { createServer as createNetServer } from 'node:net'

export async function resolveAvailableServerPort(host: string, preferredPort: number): Promise<number> {
  let port = preferredPort
  while (port < 65536) {
    const available = await isServerPortAvailable(host, port)
    if (available) {
      return port
    }
    port += 1
  }
  throw new Error(`no available server port found from ${preferredPort}`)
}

function isServerPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolveAvailable, reject) => {
    const probe = createNetServer()
    probe.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
        resolveAvailable(false)
        return
      }
      reject(error)
    })
    probe.once('listening', () => {
      probe.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolveAvailable(true)
      })
    })
    probe.listen(port, host)
  })
}
