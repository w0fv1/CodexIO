export enum AppEvent {
  StopRequested = 'app.stopRequested'
}

export type ChannelInputReceiveResult = {
  consumed?: boolean
  ioThreadId?: string
}

export type AppEventMap = {
  [AppEvent.StopRequested]: () => void
}
