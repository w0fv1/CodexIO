const receiveConfirmationStarts = [
  '收到',
  '明白',
  '好的',
  '了解',
  '可以',
  '知道了',
  '没问题',
  '我看到了',
  '已收到',
  '行'
]

const receiveConfirmationEnds = [
  '我会马上处理这条消息。',
  '我马上开始处理。',
  '我先看一下怎么处理。',
  '我来判断下一步怎么做。',
  '我会先看上下文再动手。',
  '我想想该怎么处理。',
  '我马上开始看。',
  '我会继续往下处理。',
  '我先确认情况再处理。',
  '我会尽快给出结果。'
]

export function createReceiveConfirmation(): string {
  const start = receiveConfirmationStarts[Math.floor(Math.random() * receiveConfirmationStarts.length)]
  const end = receiveConfirmationEnds[Math.floor(Math.random() * receiveConfirmationEnds.length)]
  return `${start}，${end}`
}
