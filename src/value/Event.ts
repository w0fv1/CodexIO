export enum AppEvent {
  Started = 'app.started',
  StopRequested = 'app.stopRequested',
  HttpClosed = 'app.httpClosed'
}

export type AppEventMap = {
  [AppEvent.Started]: () => void
  [AppEvent.StopRequested]: () => void
  [AppEvent.HttpClosed]: (error?: Error) => void
}
