export type Result<T> = {
  code: string
  message: string
  data: T | null
  isFailed: boolean
}

export const Result = {
  success<T>(data: T, message = 'no error'): Result<T> {
    return {
      code: '1',
      message,
      data,
      isFailed: false
    }
  },
  successVoid(message = 'no error'): Result<void> {
    return {
      code: '1',
      message,
      data: undefined,
      isFailed: false
    }
  },
  successMessage(message: string): Result<void> {
    return {
      code: '1',
      message,
      data: undefined,
      isFailed: false
    }
  },
  fail<T = void>(message: string, code = '-1', data: T | null = null): Result<T> {
    return {
      code,
      message,
      data,
      isFailed: true
    }
  },
  fromError(error: unknown): Result<void> {
    let message = String(error)
    if (error instanceof Error) {
      message = error.message
    }
    return {
      code: '-1',
      message,
      data: undefined,
      isFailed: true
    }
  }
}
