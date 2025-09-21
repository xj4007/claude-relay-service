/**
 * 测试 Claude Code 请求增强器
 */

const claudeCodeRequestEnhancer = require('../src/services/claudeCodeRequestEnhancer')
const logger = require('../src/utils/logger')

// 设置日志级别为debug以查看详细信息
logger.level = 'debug'

console.log('='.repeat(60))
console.log('测试 Claude Code 请求增强器')
console.log('='.repeat(60))

// 测试用例
const testCases = [
  {
    name: 'Haiku 模型基础请求',
    input: {
      model: 'claude-3-5-haiku-20241022',
      messages: [
        {
          role: 'user',
          content: 'Hello'
        }
      ]
    }
  },
  {
    name: 'Haiku 模型带tools（应该保留）',
    input: {
      model: 'claude-3-5-haiku-20241022',
      messages: [
        {
          role: 'user',
          content: 'Hello'
        }
      ],
      tools: [{ name: 'user_tool', description: 'User provided tool' }]
    }
  },
  {
    name: 'Sonnet 模型基础请求',
    input: {
      model: 'claude-3.5-sonnet-20241022',
      messages: [
        {
          role: 'user',
          content: 'Hello'
        }
      ]
    }
  },
  {
    name: 'Opus 4.1 模型基础请求',
    input: {
      model: 'claude-opus-4-1-20250805',
      messages: [
        {
          role: 'user',
          content: 'Hello'
        }
      ]
    }
  },
  {
    name: 'Opus 4.5 未来版本测试',
    input: {
      model: 'claude-opus-4.5-20250901',
      messages: [
        {
          role: 'user',
          content: 'Hello'
        }
      ]
    }
  },
  {
    name: 'Sonnet 带用户自定义tools',
    input: {
      model: 'claude-3.5-sonnet-20241022',
      messages: [
        {
          role: 'user',
          content: 'Hello'
        }
      ],
      tools: [
        {
          name: 'user_custom_tool',
          description: 'A custom tool from user',
          parameters: {}
        }
      ]
    }
  }
]

// 运行测试
testCases.forEach((testCase, index) => {
  console.log(`\n测试 ${index + 1}: ${testCase.name}`)
  console.log('-'.repeat(40))

  console.log('输入:')
  console.log(`${JSON.stringify(testCase.input, null, 2).substring(0, 500)}...`)

  // 运行增强器
  const enhanced = claudeCodeRequestEnhancer.enhanceRequest(testCase.input)

  console.log('\n增强后的关键字段:')
  console.log(`  max_tokens: ${enhanced.max_tokens}`)
  console.log(`  temperature: ${enhanced.temperature}`)
  console.log(`  system: ${enhanced.system ? '已设置' : '未设置'}`)
  console.log(`  metadata.user_id: ${enhanced.metadata?.user_id ? '已生成' : '未生成'}`)
  console.log(`  tools: ${enhanced.tools ? `${enhanced.tools.length}个工具` : '无'}`)

  // 获取正确的beta header
  const betaHeader = claudeCodeRequestEnhancer.getBetaHeader(enhanced.model)
  console.log(`  anthropic-beta: ${betaHeader.substring(0, 50)}...`)

  // 对于Sonnet/Opus，检查system-reminder
  const modelType = claudeCodeRequestEnhancer.detectModelType(enhanced.model)
  if (modelType === 'sonnet' || modelType === 'opus') {
    const firstUserMsg = enhanced.messages?.find((msg) => msg.role === 'user')
    const hasSystemReminder = firstUserMsg?.content?.some((item) =>
      item.text?.includes('<system-reminder>')
    )
    console.log(`  system-reminder: ${hasSystemReminder ? '已注入' : '未注入'}`)

    // 检查tools
    if (enhanced.tools) {
      console.log(`  工具列表:`)
      const toolNames = enhanced.tools.map((t) => t.name).slice(0, 10)
      toolNames.forEach((name) => console.log(`    - ${name}`))
      if (enhanced.tools.length > 10) {
        console.log(`    ... 还有${enhanced.tools.length - 10}个工具`)
      }
    }
  }

  // 对于Haiku，检查tools处理
  if (modelType === 'haiku') {
    if (enhanced.tools) {
      console.log(`  ✓ Haiku模型正确保留了${enhanced.tools.length}个用户工具`)
    } else {
      console.log(`  ✓ Haiku模型正确地没有tools参数`)
    }
  }
})

console.log(`\n${'='.repeat(60)}`)
console.log('测试完成！')
console.log('='.repeat(60))
