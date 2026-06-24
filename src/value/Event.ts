export enum AppEvent {
  StopRequested = 'app.stopRequested'
}

export type AppEventMap = {
  [AppEvent.StopRequested]: () => void
}
