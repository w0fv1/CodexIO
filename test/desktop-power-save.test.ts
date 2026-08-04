import { describe, expect, it } from 'vitest'
import { PowerSaveBlockerManager } from '../src/component/desktop/PowerSaveBlockerManager.js'
import { ConfigSchema } from '../src/value/ConfigDefinition.js'
import { isDesktopRequest } from '../src/value/DesktopMessage.js'

describe('desktop power save', () => {
  it('enables sleep prevention when loading an existing config', () => {
    const config = ConfigSchema.parse({
      app: {
        startAtLogin: false
      }
    })

    expect(config.app.preventSystemSleep).toBe(true)
  })

  it('starts one app suspension blocker and stops it when disabled', () => {
    const starts: string[] = []
    const stops: number[] = []
    const manager = new PowerSaveBlockerManager({
      start: (type) => {
        starts.push(type)
        return 41
      },
      stop: (id) => {
        stops.push(id)
        return true
      }
    })

    manager.apply(true)
    manager.apply(true)
    manager.apply(false)
    manager.apply(false)

    expect(starts).toEqual(['prevent-app-suspension'])
    expect(stops).toEqual([41])
  })

  it('accepts both supported boolean desktop settings', () => {
    expect(isDesktopRequest({
      type: 'desktop.request',
      id: 'login',
      command: 'setStartAtLogin',
      value: true
    })).toBe(true)
    expect(isDesktopRequest({
      type: 'desktop.request',
      id: 'sleep',
      command: 'setPreventSystemSleep',
      value: false
    })).toBe(true)
    expect(isDesktopRequest({
      type: 'desktop.request',
      id: 'invalid',
      command: 'setPreventDisplaySleep',
      value: true
    })).toBe(false)
  })
})
