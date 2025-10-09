# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

这个文件为 Claude Code (claude.ai/code) 提供在此代码库中工作的指导。

## 项目概述

Claude Relay Service 是一个功能完整的 AI API 中转服务，支持多平台：Claude、Gemini、OpenAI、Azure OpenAI 和 AWS Bedrock。提供多账户管理、API Key 认证、代理配置和现代化 Web 管理界面。该服务作为客户端（如 SillyTavern、Claude Code、Gemini CLI、Codex）与 AI API 之间的中间件，提供认证、限流、监控等功能。

### 支持的AI平台
- **Claude**: Anthropic官方API和Claude Console（claude.ai）
- **Gemini**: Google Gemini API
- **OpenAI**: OpenAI API（通过转换到Claude格式）
- **Azure OpenAI**: Azure OpenAI服务
- **AWS Bedrock**: Amazon Bedrock Claude模型

## 核心架构

### 关键架构概念

- **代理认证流**: 客户端用自建API Key → 验证 → 获取Claude账户OAuth token → 转发到Anthropic
- **Token管理**: 自动监控OAuth token过期并刷新，支持10秒提前刷新策略
- **代理支持**: 每个Claude账户支持独立代理配置，OAuth token交换也通过代理进行
- **数据加密**: 敏感数据（refreshToken, accessToken）使用AES加密存储在Redis

### 主要服务组件

#### 核心服务
- **claudeRelayService.js**: 核心代理服务，处理请求转发和流式响应
- **claudeAccountService.js**: Claude OAuth账户管理，token刷新和账户选择
- **claudeConsoleAccountService.js**: Claude Console账户管理（claude.ai网站登录）
- **geminiAccountService.js**: Gemini账户管理，Google OAuth token刷新和账户选择
- **geminiRelayService.js**: Gemini API请求代理和响应处理
- **bedrockAccountService.js**: AWS Bedrock账户管理和凭据处理
- **bedrockRelayService.js**: AWS Bedrock API请求代理
- **azureOpenaiAccountService.js**: Azure OpenAI账户管理
- **azureOpenaiRelayService.js**: Azure OpenAI API代理服务
- **openaiAccountService.js**: OpenAI账户管理
- **openaiToClaude.js**: OpenAI到Claude格式的请求转换器

#### 支持服务
- **apiKeyService.js**: API Key管理，验证、限流和使用统计
- **accountGroupService.js**: 账户分组管理，支持专用账户池
- **unifiedClaudeScheduler.js**: Claude账户统一调度器
- **unifiedGeminiScheduler.js**: Gemini账户统一调度器
- **unifiedOpenAIScheduler.js**: OpenAI账户统一调度器
- **tokenRefreshService.js**: Token自动刷新服务
- **pricingService.js**: 模型价格管理和成本计算
- **rateLimitCleanupService.js**: 限流状态自动清理服务
- **userService.js**: 用户管理服务（支持LDAP集成）
- **webhookService.js**: Webhook通知服务

### 认证和代理流程

1. 客户端使用自建API Key（cr\_前缀格式）发送请求
2. authenticateApiKey中间件验证API Key有效性和速率限制
3. claudeAccountService自动选择可用Claude账户
4. 检查OAuth access token有效性，过期则自动刷新（使用代理）
5. 移除客户端API Key，使用OAuth Bearer token转发请求
6. 通过账户配置的代理发送到Anthropic API
7. 流式或非流式返回响应，记录使用统计

### OAuth集成

- **PKCE流程**: 完整的OAuth 2.0 PKCE实现，支持代理
- **自动刷新**: 智能token过期检测和自动刷新机制
- **代理支持**: OAuth授权和token交换全程支持代理配置
- **安全存储**: claudeAiOauth数据加密存储，包含accessToken、refreshToken、scopes

## 常用命令

### 基本开发命令

```bash
# 安装依赖和初始化
npm install
npm run setup                  # 生成配置和管理员凭据
npm run install:web           # 安装Web界面依赖

# 开发和运行
npm run dev                   # 开发模式（热重载）
npm start                     # 生产模式（先lint后启动）
npm test                      # 运行测试
npm run lint                  # 代码检查并修复
npm run lint:check            # 仅检查不修复
npm run format                # 格式化代码
npm run format:check          # 检查格式

# Web界面构建
npm run build:web             # 构建Web管理界面

# Docker部署
npm run docker:build          # 构建Docker镜像
npm run docker:up             # 启动Docker容器
npm run docker:down           # 停止Docker容器

# 服务管理
npm run service:start:daemon  # 后台启动（推荐）
npm run service:start         # 前台启动
npm run service:restart       # 重启服务
npm run service:restart:daemon # 后台重启
npm run service:status        # 查看服务状态
npm run service:logs          # 查看日志
npm run service:logs:follow   # 实时跟踪日志
npm run service:stop          # 停止服务

# 系统监控和管理
npm run monitor               # 增强监控脚本
npm run status                # 统一状态检查
npm run status:detail         # 详细状态信息
npm run cli                   # CLI工具入口

# 数据管理
npm run data:export           # 导出数据
npm run data:import           # 导入数据
npm run data:export:sanitized # 导出脱敏数据
npm run data:export:enhanced  # 增强导出
npm run data:export:encrypted # 加密导出
npm run data:import:enhanced  # 增强导入
npm run data:debug            # 调试Redis键值

# 价格和成本管理
npm run update:pricing        # 更新模型价格
npm run init:costs            # 初始化成本数据
npm run test:pricing-fallback # 测试价格回退机制

# 数据库迁移
npm run migrate:apikey-expiry # 迁移API Key过期时间
npm run migrate:apikey-expiry:dry # 干运行迁移
npm run migrate:fix-usage-stats # 修复使用统计数据
```

### 开发环境配置
必须配置的环境变量：
- `JWT_SECRET`: JWT密钥（32字符以上随机字符串）
- `ENCRYPTION_KEY`: 数据加密密钥（32字符固定长度）
- `REDIS_HOST`: Redis主机地址（默认localhost）
- `REDIS_PORT`: Redis端口（默认6379）
- `REDIS_PASSWORD`: Redis密码（可选）

初始化命令：
```bash
cp config/config.example.js config/config.js
cp .env.example .env
npm run setup  # 自动生成密钥并创建管理员账户
```

## Web界面功能

### OAuth账户添加流程

1. **基本信息和代理设置**: 配置账户名称、描述和代理参数
2. **OAuth授权**:
   - 生成授权URL → 用户打开链接并登录Claude Code账号
   - 授权后会显示Authorization Code → 复制并粘贴到输入框
   - 系统自动交换token并创建账户

### 核心管理功能

- **实时仪表板**: 系统统计、账户状态、使用量监控
- **API Key管理**: 创建、配额设置、使用统计查看
- **Claude账户管理**: OAuth账户添加、代理配置、状态监控
- **系统日志**: 实时日志查看，多级别过滤
- **主题系统**: 支持明亮/暗黑模式切换，自动保存用户偏好设置

## 重要端点

### API转发端点（多平台支持）

#### Claude API端点
- `POST /api/v1/messages` - 主要消息处理端点（支持流式）
- `POST /claude/v1/messages` - Claude路由别名（与/api功能相同）
- `GET /api/v1/models` - 模型列表（兼容性）
- `GET /api/v1/usage` - 使用统计查询
- `GET /api/v1/key-info` - API Key信息

#### Gemini API端点
- `POST /gemini/v1/models/{model}:generateContent` - Gemini消息生成
- `POST /gemini/v1/models/{model}:streamGenerateContent` - Gemini流式生成
- `GET /gemini/v1/models` - Gemini模型列表

#### OpenAI兼容端点
- `POST /openai/v1/chat/completions` - OpenAI格式到Claude转换
- `POST /openai/claude/v1/chat/completions` - OpenAI到Claude专用端点
- `POST /openai/gemini/v1/chat/completions` - OpenAI到Gemini转换
- `GET /openai/v1/models` - OpenAI兼容模型列表

#### Azure OpenAI端点
- `POST /azure/openai/deployments/{deployment}/chat/completions` - Azure OpenAI代理

### Web管理界面

- `GET /` - 根路径重定向到管理界面
- `GET /admin-next/` - 新版Web管理界面（SPA）
- `GET /web` - 旧版Web界面重定向

### 管理API端点

#### 账户管理
- `POST /admin/claude-accounts/generate-auth-url` - 生成OAuth授权URL（含代理）
- `POST /admin/claude-accounts/exchange-code` - 交换authorization code
- `POST /admin/claude-accounts` - 创建OAuth账户
- `GET /admin/claude-accounts` - 获取Claude账户列表
- `PUT /admin/claude-accounts/{id}` - 更新Claude账户
- `DELETE /admin/claude-accounts/{id}` - 删除Claude账户

#### API Key管理
- `GET /admin/api-keys` - 获取API Key列表
- `POST /admin/api-keys` - 创建新API Key
- `PUT /admin/api-keys/{id}` - 更新API Key
- `DELETE /admin/api-keys/{id}` - 删除API Key

#### 用户管理（可选功能）
- `GET /users/profile` - 获取用户档案
- `POST /users/login` - 用户登录（支持LDAP）
- `POST /users/logout` - 用户登出

#### Webhook管理
- `GET /admin/webhook/config` - 获取Webhook配置
- `POST /admin/webhook/config` - 更新Webhook配置
- `POST /admin/webhook/test` - 测试Webhook

### 系统端点

- `GET /health` - 健康检查（包含Redis、日志系统状态）
- `GET /metrics` - 系统指标和统计信息
- `GET /admin/dashboard` - 系统概览数据
- `GET /apiStats/overview` - API使用统计概览

## 故障排除

### OAuth相关问题

1. **代理配置错误**: 检查代理设置是否正确，OAuth token交换也需要代理
2. **授权码无效**: 确保复制了完整的Authorization Code，没有遗漏字符
3. **Token刷新失败**: 检查refreshToken有效性和代理配置

### Gemini Token刷新问题

1. **刷新失败**: 确保 refresh_token 有效且未过期
2. **错误日志**: 查看 `logs/token-refresh-error.log` 获取详细错误信息
3. **测试脚本**: 运行 `node scripts/test-gemini-refresh.js` 测试 token 刷新

### 常见开发问题

1. **Redis连接失败**: 确认Redis服务运行，检查连接配置
2. **管理员登录失败**: 检查init.json同步到Redis，运行npm run setup
3. **API Key格式错误**: 确保使用cr\_前缀格式
4. **代理连接问题**: 验证SOCKS5/HTTP代理配置和认证信息

### 调试工具

- **日志系统**: Winston结构化日志，支持不同级别
- **CLI工具**: 命令行状态查看和管理
- **Web界面**: 实时日志查看和系统监控
- **健康检查**: /health端点提供系统状态

## 开发最佳实践

### 代码格式化要求

- **必须使用 Prettier 格式化所有代码**
- 后端代码（src/）：运行 `npx prettier --write <file>` 格式化
- 前端代码（web/admin-spa/）：已安装 `prettier-plugin-tailwindcss`，运行 `npx prettier --write <file>` 格式化
- 提交前检查格式：`npx prettier --check <file>`
- 格式化所有文件：`npm run format`（如果配置了此脚本）

### 前端开发特殊要求

- **响应式设计**: 必须兼容不同设备尺寸（手机、平板、桌面），使用 Tailwind CSS 响应式前缀（sm:、md:、lg:、xl:）
- **暗黑模式兼容**: 项目已集成完整的暗黑模式支持，所有新增/修改的UI组件都必须同时兼容明亮模式和暗黑模式
  - 使用 Tailwind CSS 的 `dark:` 前缀为暗黑模式提供样式
  - 文本颜色：`text-gray-700 dark:text-gray-200`
  - 背景颜色：`bg-white dark:bg-gray-800`
  - 边框颜色：`border-gray-200 dark:border-gray-700`
  - 状态颜色保持一致：`text-blue-500`、`text-green-600`、`text-red-500` 等
- **主题切换**: 使用 `stores/theme.js` 中的 `useThemeStore()` 来实现主题切换功能
- **玻璃态效果**: 保持现有的玻璃态设计风格，在暗黑模式下调整透明度和背景色
- **图标和交互**: 确保所有图标、按钮、交互元素在两种模式下都清晰可见且易于操作

### 代码修改原则

- 对现有文件进行修改时，首先检查代码库的现有模式和风格
- 尽可能重用现有的服务和工具函数，避免重复代码
- 遵循项目现有的错误处理和日志记录模式
- 敏感数据必须使用加密存储（参考 claudeAccountService.js 中的加密实现）

### 测试和质量保证

- 运行 `npm run lint` 进行代码风格检查（使用 ESLint）
- 运行 `npm test` 执行测试套件（Jest + SuperTest 配置）
- 在修改核心服务后，使用 CLI 工具验证功能：`npm run cli status`
- 检查日志文件 `logs/claude-relay-*.log` 确认服务正常运行
- 注意：当前项目缺少实际测试文件，建议补充单元测试和集成测试

### 开发工作流

- **功能开发**: 始终从理解现有代码开始，重用已有的服务和模式
- **调试流程**: 使用 Winston 日志 + Web 界面实时日志查看 + CLI 状态工具
- **代码审查**: 关注安全性（加密存储）、性能（异步处理）、错误处理
- **部署前检查**: 运行 lint → 测试 CLI 功能 → 检查日志 → Docker 构建

### 常见文件位置

- 核心服务逻辑：`src/services/` 目录
- 路由处理：`src/routes/` 目录
- 中间件：`src/middleware/` 目录
- 配置管理：`config/config.js`
- Redis 模型：`src/models/redis.js`
- 工具函数：`src/utils/` 目录
- 前端主题管理：`web/admin-spa/src/stores/theme.js`
- 前端组件：`web/admin-spa/src/components/` 目录
- 前端页面：`web/admin-spa/src/views/` 目录

### 重要架构决策

- 所有敏感数据（OAuth token、refreshToken）都使用 AES 加密存储在 Redis
- 每个 Claude 账户支持独立的代理配置，包括 SOCKS5 和 HTTP 代理
- API Key 使用哈希存储，支持 `cr_` 前缀格式
- 请求流程：API Key 验证 → 账户选择 → Token 刷新（如需）→ 请求转发
- 支持流式和非流式响应，客户端断开时自动清理资源

### 核心数据流和性能优化

- **哈希映射优化**: API Key 验证从 O(n) 优化到 O(1) 查找
- **智能 Usage 捕获**: 从 SSE 流中解析真实的 token 使用数据
- **多维度统计**: 支持按时间、模型、用户的实时使用统计
- **异步处理**: 非阻塞的统计记录和日志写入
- **原子操作**: Redis 管道操作确保数据一致性

### 安全和容错机制

- **多层加密**: API Key 哈希 + OAuth Token AES 加密
- **零信任验证**: 每个请求都需要完整的认证链
- **优雅降级**: Redis 连接失败时的回退机制
- **自动重试**: 指数退避重试策略和错误隔离
- **资源清理**: 客户端断开时的自动清理机制

## 项目特定注意事项

### Redis 数据结构

#### 账户管理
- **API Keys**: `api_key:{id}` (详细信息) + `api_key_hash:{hash}` (快速查找)
- **Claude 账户**: `claude_account:{id}` (加密的 OAuth 数据)
- **Claude Console账户**: `claude_console_account:{id}` (claude.ai网站账户)
- **Gemini 账户**: `gemini_account:{id}` (Google OAuth数据)
- **Bedrock 账户**: `bedrock_account:{id}` (AWS凭据信息)
- **Azure OpenAI账户**: `azure_account:{id}` (Azure服务信息)
- **OpenAI 账户**: `openai_account:{id}` (OpenAI API密钥)

#### 用户和权限
- **管理员**: `admin:{id}` + `admin_username:{username}` (用户名映射)
- **用户**: `user:{id}` + `user_username:{username}` (LDAP用户映射)
- **会话**: `session:{token}` (JWT 会话管理)
- **管理员凭据**: `admin_credentials` (管理员登录信息)

#### 统计和监控
- **使用统计**: `usage:daily:{date}:{key}:{model}` (多维度统计)
- **成本统计**: `cost:daily:{date}:{key}:{model}` (成本追踪)
- **系统信息**: `system_info` (系统状态缓存)
- **限流状态**: `rate_limit:{key}:{window}` (API Key限流状态)

#### 账户调度和状态
- **账户调度**: `scheduler:{platform}:next_account` (下一个可用账户)
- **账户错误状态**: `account_error:{platform}:{id}` (账户错误追踪)
- **粘性会话**: `sticky_session:{key}:{platform}` (会话关联)
- **Token刷新锁**: `token_refresh_lock:{id}` (防止并发刷新)

### 流式响应处理

- 支持 SSE (Server-Sent Events) 流式传输
- 自动从流中解析 usage 数据并记录
- 客户端断开时通过 AbortController 清理资源
- 错误时发送适当的 SSE 错误事件

### CLI 工具使用示例

```bash
# API Key管理
npm run cli keys create -- --name "MyApp" --limit 1000  # 创建API Key
npm run cli keys list                                    # 列出所有API Keys
npm run cli keys delete -- --id <keyId>                 # 删除API Key
npm run cli keys usage -- --id <keyId>                  # 查看使用统计

# 系统状态
npm run cli status                                       # 查看系统状态
npm run cli stats                                        # 查看统计信息
npm run cli health                                       # 健康检查

# Claude账户管理
npm run cli accounts list                                # 列出所有账户
npm run cli accounts claude list                         # 列出Claude账户
npm run cli accounts gemini list                         # 列出Gemini账户
npm run cli accounts refresh <accountId>                 # 刷新指定账户token
npm run cli accounts test <accountId>                    # 测试账户连接

# 管理员操作
npm run cli admin create -- --username admin2           # 创建管理员
npm run cli admin reset-password -- --username admin    # 重置密码
npm run cli admin login                                  # 管理员登录

# 数据管理
npm run cli data export                                  # 导出数据
npm run cli data import -- --file backup.json           # 导入数据
npm run cli data cleanup                                 # 清理过期数据

# 调试和测试
npm run cli debug redis                                  # Redis调试信息
npm run cli debug accounts                               # 账户调试信息
npm run cli test api -- --key <apiKey>                  # 测试API Key
npm run cli test account -- --id <accountId>            # 测试账户
```

### 脚本工具使用

```bash
# 管理脚本（推荐使用）
./scripts/manage.sh                                      # 交互式管理菜单
./scripts/manage.sh install                              # 一键安装
./scripts/manage.sh start                                # 启动服务
./scripts/manage.sh stop                                 # 停止服务
./scripts/manage.sh restart                              # 重启服务
./scripts/manage.sh status                               # 查看状态
./scripts/manage.sh update                               # 更新服务

# 监控脚本
./scripts/monitor-enhanced.sh                            # 增强监控
./scripts/status-unified.sh                              # 统一状态检查
./scripts/status-unified.sh --detail                     # 详细状态信息

# 测试脚本
node scripts/test-gemini-refresh.js                      # 测试Gemini token刷新
node scripts/test-api-response.js                        # 测试API响应
node scripts/test-bedrock-models.js                      # 测试Bedrock模型
node scripts/test-group-scheduling.js                    # 测试分组调度

# 数据迁移脚本
node scripts/migrate-apikey-expiry.js                    # 迁移API Key过期时间
node scripts/fix-usage-stats.js                          # 修复使用统计
node scripts/generate-test-data.js                       # 生成测试数据
```

# important-instruction-reminders

Do what has been asked; nothing more, nothing less.
NEVER create files unless they're absolutely necessary for achieving your goal.
ALWAYS prefer editing an existing file to creating a new one.
NEVER proactively create documentation files (\*.md) or README files. Only create documentation files if explicitly requested by the User.





 现在我已经读取了三个关键的文件：
  1. claudeRelayService.js - 核心请求代理服务
  2. claudeCodeHeadersService.js - Claude Code headers管理  
  3. unifiedClaudeScheduler.js - 统一的账户调度器

  基于这些代码，我可以完整地回答用户的问题了。让我分析一下：

  关键逻辑分析

  1. 人数控制和均衡人数

  从 unifiedClaudeScheduler.js 可以看出：
  - 第620-632行：_sortAccountsByPriority() 方法实现了负载均衡
  - 优先级相同时，按最后使用时间排序（最久未使用的优先）
  - 这实现了基于优先级的轮询调度

  2. 优先级机制

  - 第455行、504行等：每个账户都有 priority 字段，默认为50
  - 第623-625行：数字越小优先级越高
  - 第627-631行：优先级相同时按最后使用时间排序

  3. 并发控制和分发机制

  - 没有直接的并发限制逻辑，但有多种状态管理：
    - 限流状态 (rate limited)
    - 过载状态 (overloaded) 
    - 错误状态 (error, blocked, temp_error)
    - 额度超额 (quota exceeded)

  4. Token粘性机制

  - 第82-83行：通过 sessionHelper.generateSessionHash(requestBody) 生成会话哈希

  - 第230-261行：检查是否有已映射的账户
  - 第787-864行：完整的会话映射管理逻辑
  - 第810-813行：TTL配置，默认1小时

  5. 供应商分发机制

  会话映射和供应商路由是系统的核心调度策略。selectAccountForApiKey() 
  方法支持多平台分发，包括Claude官方、Claude Console、Bedrock和CCR。系统通过供应商前缀路由实现精细化  
  的账户分配，确保请求能够精准地路由到最合适的服务提供商。

● 基于这两个文件的代码分析，我来详细解答你的问题：

  🎯 核心调度逻辑分析

  1. 人数控制和均衡策略

  负载均衡实现：unifiedClaudeScheduler.js:620-632 
  _sortAccountsByPriority(accounts) {
    return accounts.sort((a, b) => {
      // 首先按优先级排序（数字越小优先级越高）
      if (a.priority !== b.priority) {
        return a.priority - b.priority
      }
      // 优先级相同时，按最后使用时间排序（最久未使用的优先）
      const aLastUsed = new Date(a.lastUsedAt || 0).getTime()
      const bLastUsed = new Date(b.lastUsedAt || 0).getTime()
      return aLastUsed - bLastUsed
    })
  }

  人数均衡机制：
  - ✅ 基于优先级的轮询调度：优先级相同的账户会按最后使用时间轮换
  - ✅ 最少使用优先：lastUsedAt 字段确保最久未使用的账户优先被选择
  - ✅ 多账户池支持：支持 Claude官方、Claude Console、Bedrock、CCR 多个账户池

  2. 优先级机制详解

  优先级配置：unifiedClaudeScheduler.js:455
  priority: parseInt(account.priority) || 50  // 默认优先级50

  优先级规则：
  - 🔢 数字越小优先级越高（1 > 10 > 50）
  - 🎯 优先级对应调度顺序，不是直接对应人数
  - ⚖️ 相同优先级内实现负载均衡（按最后使用时间轮换）

  3. 并发处理和供应商分发

  并发超限时的处理逻辑：

  当某个账户遇到问题时，系统会自动切换：

  // claudeRelayService.js:243-254 - 检测到限流时
  if (isRateLimited) {
    await unifiedClaudeScheduler.markAccountRateLimited(
      accountId, accountType, sessionHash, rateLimitResetTimestamp
    )
  }

  多供应商分发机制：unifiedClaudeScheduler.js:127-139
  // 解析供应商前缀
  const { vendor, baseModel } = parseVendorPrefixedModel(requestedModel)

  // 如果是 CCR 前缀，只在 CCR 账户池中选择
  if (vendor === 'ccr') {
    return await this._selectCcrAccount(apiKeyData, sessionHash, effectiveModel)
  }

  错误状态管理：
  - 🚫 rate_limited - 429错误自动标记
  - 🔐 unauthorized - 401错误自动标记
  - 🚧 blocked - 403错误自动标记
  - 🔥 overloaded - 529错误自动标记
  - ⚠️ temp_error - 5xx错误累计标记

  4. Token粘性机制（缓存计算保持）

  会话粘性实现：unifiedClaudeScheduler.js:230-261

  // 检查是否有已映射的账户
  if (sessionHash) {
    const mappedAccount = await this._getSessionMapping(sessionHash)
    if (mappedAccount) {
      const isAvailable = await this._isAccountAvailable(
        mappedAccount.accountId, mappedAccount.accountType, effectiveModel
      )
      if (isAvailable) {
        return mappedAccount  // 使用相同账户保持缓存
      }
    }
  }

  粘性配置：unifiedClaudeScheduler.js:810-813
  const ttlHours = appConfig.session?.stickyTtlHours || 1  // 默认1小时
  const ttlSeconds = Math.max(1, Math.floor(ttlHours * 60 * 60))

  粘性特点：
  - 🔄 智能续期：使用频繁时自动延长TTL
  - 🎯 账户绑定：同一会话始终使用相同账户
  - 🧹  自动清理：账户不可用时自动清除粘性映射

  💡 回答你的具体问题

  Q1: 如何控制人数和均衡人数？

  - 通过设置账户的 priority 字段控制优先级
  - 相同优先级账户间自动负载均衡（最少使用优先）
  - 可以通过账户分组 (group:) 实现专用账户池

  Q2: 优先级是否对应人数？

  - 不是直接对应，优先级控制的是调度顺序
  - 低优先级数字的账户优先被选择
  - 相同优先级内通过 lastUsedAt 实现轮换

  Q3: 并发超了怎么处理？

  - 系统会自动检测各种错误状态并标记账户
  - 不可用账户会被跳过，自动选择其他可用账户
  - 支持跨供应商分发：可以从 Claude 切换到 Bedrock 等

  Q4: Token粘性是否保持供应商？

  - 是的，会话粘性确保同一 sessionHash 使用相同账户
  - 这正是为了保持缓存计算的连续性
  - 默认1小时TTL，可配置延长

  🔧 配置建议

  1. 人数控制：设置不同的 priority 值（1-100）
  2. 负载均衡：相同优先级的账户会自动轮换
  3. 并发处理：系统自动容错，无需手动干预
  4. 缓存保持：会话粘性默认开启，确保计算连续性

  这个架构设计得相当完善，既支持灵活的负载均衡，又保证了会话的连续性。





  ================================================================


  🔍 多终端场景下的供应商分配深度分析

  基于对核心代码的分析，我来详细回答你关于多终端缓存命中的担忧：

  📋 关键发现：会话哈希生成机制（sessionHelper.js:11-143）      

  会话哈希的生成优先级：

  1. 最高优先级：metadata.user_id 中的 session_xxx
  2. 次优先级：带有 cache_control: {"type": "ephemeral"} 的内容哈希
  3. 第三优先级：system 内容哈希
  4. 兜底策略：第一条消息内容哈希

  🎯 多终端场景分析

  情况1：使用相同提示内容

  // 终端A和终端B使用相同的system内容或缓存内容
  const sessionHashA = crypto.createHash('sha256').update(systemText).digest('hex').substring(0,      
  32)
  const sessionHashB = crypto.createHash('sha256').update(systemText).digest('hex').substring(0,      
  32)
  // sessionHashA === sessionHashB ✅ 会命中同一账户

  结果：会使用同一供应商账户 - ✅ 缓存命中

  情况2：使用不同提示内容

  // 终端A：system = "你是AI助手A"
  // 终端B：system = "你是AI助手B" 
  // 生成的sessionHash完全不同

  结果：会分配到不同供应商账户 - ❌ 缓存不命中

  🔗 粘性会话机制（unifiedClaudeScheduler.js:230-261）

  // 检查是否有已映射的账户
  if (sessionHash) {
    const mappedAccount = await this._getSessionMapping(sessionHash)
    if (mappedAccount && isAvailable) {
      // 🎯 使用相同账户保持缓存
      await this._extendSessionMappingTTL(sessionHash)
      return mappedAccount  // 相同sessionHash总是返回相同账户
    }
  }

  ⚡ 实际场景分析

  场景A：Claude Code 多终端（高概率缓存命中）

  # 所有终端都使用相同的system prompt
  终端1：system = "你是Claude，Anthropic的AI助手..."
  终端2：system = "你是Claude，Anthropic的AI助手..."
  终端3：system = "你是Claude，Anthropic的AI助手..."
  结果：所有终端 → 相同sessionHash → 相同供应商账户 → ✅ 缓存完美命中

  场景B：不同应用/不同配置（缓存不命中）

  # 不同的system内容
  SillyTavern：system = "你是角色A，性格活泼..."
  Cursor：system = "你是代码助手，专门帮助编程..."
  自定义脚本：system = "你是翻译助手..."
  结果：不同sessionHash → 不同供应商账户 → ❌ 缓存不命中

  🛠️ 优化建议

  1. 统一Session ID（推荐）

  在多终端使用时主动传入统一的session标识：

  // 所有终端使用相同的user_id
  const requestBody = {
    metadata: {
      user_id: "session_12345678-abcd-1234-5678-123456789abc"  // 36位UUID
    },
    // ... 其他内容
  }

  2. 使用Cache Control标记

  对需要缓存的内容添加ephemeral标记：

  const requestBody = {
    system: [
      {
        type: "text",
        text: "你是AI助手...",
        cache_control: { type: "ephemeral" }  // 标记为可缓存
      }
    ]
  }

  📊 TTL和续期机制（unifiedClaudeScheduler.js:810-864）

  // 默认配置
  const ttlHours = appConfig.session?.stickyTtlHours || 1  // 1小时TTL
  const renewalThresholdMinutes = appConfig.session?.renewalThresholdMinutes || 0

  // 智能续期：频繁使用时自动延长
  if (remainingTTL < threshold) {
    await client.expire(key, fullTTL)  // 续期到完整TTL
  }

  🎯 最终答案

  对于你的担忧 - "就怕没命中缓存"：

  1. 如果多终端使用相同内容：✅ 会命中同一供应商账户，缓存完美利用
  2. 如果多终端使用不同内容：❌ 会分配不同账户，缓存无法共享

  关键建议：
  - 确保所有终端使用统一的system prompt或相同的metadata.user_id
  - 考虑在客户端配置中设置固定的session标识符
  - 利用Anthropic的prompt caching机制，添加cache_control标记

  这个设计既保证了缓存的有效利用，又避免了不同会话间的缓存混乱，是一个很好的平衡。



  







  问题分析

  这个错误 [dumb-init] /usr/local/bin/docker-entrypoint.sh: No such file or directory 说明：
要将项目中的和目录/usr/local/bin的一起执行sed -i 's/\r$//' docker-entrypoint.sh即可解决

  1. Docker 镜像构建成功了（否则不会到 ENTRYPOINT 这步）
  2. 但是 docker-entrypoint.sh 文件没有被正确复制到镜像中

  可能的原因

  1. 文件换行符问题（最常见）

  Windows 打包的文件包含 \r\n (CRLF)，Linux 需要 \n (LF)

  2. 文件权限问题

  在 Windows 打包时可能丢失了执行权限

  3. 文件编码问题

  文件可能包含特殊字符或BOM

  请提供这些信息

  在服务器上执行，给我结果：

  # 1. 检查文件是否真的存在
  ls -la docker-entrypoint.sh

  # 2. 检查文件内容格式（看第一行）
  head -1 docker-entrypoint.sh | cat -A

  # 3. 检查完整文件格式
  file docker-entrypoint.sh

  快速修复方案

  如果是换行符问题，执行这个：

  # 修复换行符
  dos2unix docker-entrypoint.sh
  # 或者用sed
  sed -i 's/\r$//' docker-entrypoint.sh

  # 设置权限
  chmod +x docker-entrypoint.sh

  # 重新构建
  docker-compose down
  docker-compose up --build -d

  给我看看检查命令的结果，我就能确定具体问题了。
  有修改过前端就在本地执行 
  npm run build:web             # 构建Web管理界面


  网络设置：
把这个域名加到黑名单，不让他访问网络：(作用是屏蔽claude code收集数据服务，防止咱们被封号)
具体位：修改  /etc/hosts 增加一行：127.0.0.1 statsig.anthropic.com


如果有什么新的报错账号过滤要在代码里面添加
  // 📋 获取所有Claude Console账户
  async getAllAccounts() {
    try {
      const client = redis.getClientSafe()
      const keys = await client.keys(`${this.ACCOUNT_KEY_PREFIX}*`)
      const accounts = []

      for (const key of keys) {
        // 🔧 跳过非账户键（如 slow_responses、5xx_errors 等辅助数据）
        if (
          key.includes(':slow_responses') ||
          key.includes(':5xx_errors') ||
          key.includes(':temp_error')
        ) {
          continue
        }