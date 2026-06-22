import { CodexioConfig } from '../ConfigService.js'
import { FileStore } from '../component/FileStore.js'
import { FeishuMessageSender } from '../channel/FeishuMessageSender.js'
import { Result } from '../value/Result.js'

export type ConfigActionDescriptor = {
  id: string
  group: string
  label: string
}

export type ConfigActionResult = {
  message: string
}

export type ConfigActionContext = {
  config: CodexioConfig
  fileStore: FileStore
}

export type ConfigAction = {
  descriptor: ConfigActionDescriptor
  run: (context: ConfigActionContext) => Promise<Result<ConfigActionResult>>
}

const feishuTestImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAMgAAAB4CAIAAAD2HxkiAAABvUlEQVR4nO3bwQ3CMBBAQZP+OzYVHaCyqlgRWkWsdyMg+6w9j5xzA/BtsQFsQFsQFsQFsQFsQFsQFsQFsQFsQFsQFsQFsQFsQFsQFsQFsQFsQFsQFsQFsQFsQFu4ftfnfa83zHN+fK+Zz7hgfH3+PS/Pr/ux15we7Bae2M8YdR82QW3VPzt5ipttW7f6wWnR4dknB1mssG1ngS1p+mg0qF43Bha/z7RtknkxYGrppvdjleRq0N2pBrcsbW9tXt3LFLN9fVbgf+bdQHYnlx2bcKscuHYGOxJ5bl2C8D3alw2zl3gBvze0iWHD9j9D2TQd9e76nZ3+gM9s3OSj3vqNwV06UuGe+5b5oQnOdTJ3m+eTnEGEyDOD8at7+npUYyvJXT+2knQ3aLn1TM+bEUELv1IhzGv0xTIwDgKTl3WlcwZtTd4kWR19QaWbFkx9p2KZqzXJ9z3p0P8YdHDXj6+z8lYp9dOqJAl9L0AkIggEwkIggEwkIggEwkIggEwkIggEwkIggEwkIggEwkIggEwkIggEwkIggEwkIggEwkIggEwkIggEwkIggEwkIggEwkIggEwkIggEwkIggEwkIggEwkIggEwkIggEwkIggEwkIggH8Z/gFhhG1W9C8AsQAAAABJRU5ErkJggg==', 'base64')

export const defaultConfigActions: ConfigAction[] = [
  {
    descriptor: {
      id: 'channels.feishu.testMessage',
      group: 'Feishu',
      label: '测试消息和图片'
    },
    run: async ({ config, fileStore }) => {
      const file = await fileStore.importBuffer({
        buffer: feishuTestImage,
        name: 'codexio-feishu-test.png'
      })
      const sent = await new FeishuMessageSender(config.channels.feishu).send({
        role: 'system',
        source: 'config',
        text: 'Codexio Feishu 测试消息',
        createdAt: Date.now(),
        files: [
          file
        ]
      })
      if (sent.isFailed) {
        return Result.fail(sent.message)
      }
      return Result.success({
        message: 'Feishu 测试消息已发送。'
      })
    }
  }
]

export function configActionDescriptors(actions = defaultConfigActions): ConfigActionDescriptor[] {
  return actions.map((action) => action.descriptor)
}

export async function executeConfigAction(id: string, context: ConfigActionContext, actions = defaultConfigActions): Promise<Result<ConfigActionResult>> {
  const action = actions.find((item) => item.descriptor.id === id)
  if (!action) {
    return Result.fail('config action not found', '404')
  }
  return action.run(context)
}
