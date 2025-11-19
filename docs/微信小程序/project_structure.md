# Claude Relay Service - 项目结构详解

## 项目概览

Claude Relay Service 是一个多平台 AI API 中转服务，采用现代化的前后端分离架构。项目包含完整的后端 API 服务、前端管理界面、Docker 部署配置和命令行工具。

**项目规模:**
- 后端服务: 40+ 个核心服务文件
- 路由处理: 15 个路由文件
- 前端组件: 50+ 个 Vue 组件
- 工具函数: 24 个工具模块
- 脚本工具: 30+ 个管理和测试脚本

---

## 1. 项目主要目录划分

```
claude-relay-service/
├── src/                          # 后端源代码
├── web/                          # 前端项目
├── config/                       # 配置文件
├── scripts/                      # 管理和部署脚本
├── cli/                          # 命令行工具
├── data/                         # 数据存储（init.json等）
├── logs/                         # 日志文件
├── temp/                         # 临时文件
├── docs/                         # 文档
├── resources/                    # 资源文件
├── Dockerfile                    # Docker 镜像定义
├── docker-compose.yml            # Docker Compose 配置
├── docker-entrypoint.sh          # Docker 启动脚本
├── package.json                  # 后端依赖管理
├── .env                          # 环境变量配置
├── .env.example                  # 环境变量示例
├── CLAUDE.md                     # 项目指导文档
├── README.md                     # 项目说明
└── Makefile                      # Make 命令配置
```

---

## 2. 后端服务结构 (src/)

### 2.1 核心入口

```
src/
├── app.js                        # Express 应用主入口
│   ├── 初始化 Express 服务器
│   ├── 加载中间件
│   ├── 注册路由
│   ├── 启动 Redis 连接
│   └── 启动定时任务
```

### 2.2 服务层 (src/services/) - 40+ 个服务文件

#### 账户管理服务 (8 种账户类型)

- claudeAccountService.js - Claude 官方账户管理
- claudeConsoleAccountService.js - Claude Console 账户管理
- geminiAccountService.js - Gemini 账户管理
- bedrockAccountService.js - AWS Bedrock 账户管理
- azureOpenaiAccountService.js - Azure OpenAI 账户管理
- droidAccountService.js - Droid (Factory.ai) 账户管理
- openaiResponsesAccountService.js - OpenAI Responses 账户管理
- ccrAccountService.js - CCR 账户管理

#### API 转发服务 (8 种平台)

- claudeRelayService.js - Claude 官方 API 转发
- claudeConsoleRelayService.js - Claude Console API 转发
- geminiRelayService.js - Gemini API 转发
- bedrockRelayService.js - AWS Bedrock API 转发
- azureOpenaiRelayService.js - Azure OpenAI API 转发
- droidRelayService.js - Droid API 转发
- openaiResponsesRelayService.js - OpenAI Responses API 转发
- ccrRelayService.js - CCR API 转发

#### 统一调度器 (智能账户选择)

- unifiedClaudeScheduler.js - Claude 多账户类型统一调度
- unifiedGeminiScheduler.js - Gemini 账户统一调度
- unifiedOpenAIScheduler.js - OpenAI 兼容服务统一调度
- droidScheduler.js - Droid 账户调度

#### 核心功能服务

- apiKeyService.js - API Key 管理 (70KB+)
- userService.js - 用户管理系统
- pricingService.js - 定价和成本计算
- costInitService.js - 成本数据初始化
- webhookService.js - Webhook 通知服务
- webhookConfigService.js - Webhook 配置管理
- ldapService.js - LDAP 认证服务
- tokenRefreshService.js - Token 自动刷新服务
- rateLimitCleanupService.js - 速率限制清理服务
- accountGroupService.js - 账户组管理
- contentModerationService.js - 内容审核服务
- responseCacheService.js - 响应缓存服务
- smartCacheOptimizer.js - 智能缓存优化
- claudeCodeHeadersService.js - Claude Code 请求头处理
- claudeCodeRequestEnhancer.js - Claude Code 请求增强
- claudeCodeToolsManager.js - Claude Code 工具管理
- modelService.js - 模型管理服务
- openaiAccountService.js - OpenAI 兼容账户管理
- openaiToClaude.js - OpenAI 到 Claude 格式转换
- billingEventPublisher.js - 计费事件发布

### 2.3 路由层 (src/routes/) - 15 个路由文件

- api.js - 主 API 路由 (57KB)
- admin.js - 管理端点 (317KB)
- geminiRoutes.js - Gemini API 路由 (33KB)
- openaiRoutes.js - OpenAI API 路由 (56KB)
- openaiClaudeRoutes.js - OpenAI 格式转 Claude (16KB)
- openaiGeminiRoutes.js - OpenAI 格式转 Gemini (22KB)
- standardGeminiRoutes.js - 标准 Gemini 路由 (30KB)
- azureOpenaiRoutes.js - Azure OpenAI 路由 (12KB)
- droidRoutes.js - Droid 路由 (4KB)
- apiStats.js - API 统计路由 (37KB)
- userRoutes.js - 用户路由 (23KB)
- webhook.js - Webhook 路由 (12KB)
- web.js - Web 界面路由 (10KB)
- unified.js - 统一路由 (6KB)

### 2.4 中间件层 (src/middleware/)

- auth.js - 认证中间件 (46KB)
- browserFallback.js - 浏览器回退中间件

### 2.5 数据模型层 (src/models/)

- redis.js - Redis 数据模型 (80KB)

### 2.6 工具函数层 (src/utils/) - 24 个工具模块

- logger.js - Winston 日志系统
- oauthHelper.js - OAuth 工具
- proxyHelper.js - 代理工具
- sessionHelper.js - 会话管理工具
- cacheMonitor.js - 缓存监控工具
- costCalculator.js - 成本计算工具
- inputValidator.js - 输入验证工具
- lruCache.js - LRU 缓存实现
- modelHelper.js - 模型工具
- rateLimitHelper.js - 速率限制工具
- tokenMask.js - Token 脱敏工具
- tokenRefreshLogger.js - Token 刷新日志
- webhookNotifier.js - Webhook 通知工具
- workosOAuthHelper.js - WorkOS OAuth 工具
- contents.js - 内容处理工具
- dateHelper.js - 日期工具
- errorSanitizer.js - 错误脱敏工具
- intelligentErrorFilter.js - 智能错误过滤
- requestQueue.js - 请求队列工具
- retryManager.js - 重试管理工具
- streamHelpers.js - 流处理工具
- sseConverter.js - SSE 转换工具
- runtimeAddon.js - 运行时扩展

---

## 3. 前端项目结构 (web/admin-spa/)

### 3.1 项目配置

- package.json - 前端依赖管理
- vite.config.js - Vite 构建配置
- tailwind.config.js - Tailwind CSS 配置
- postcss.config.js - PostCSS 配置
- .eslintrc.cjs - ESLint 配置
- .prettierrc - Prettier 配置
- index.html - HTML 入口
- dist/ - 构建输出目录

### 3.2 源代码结构 (src/)

**views/ (10 个页面视图)**
- LoginView.vue - 登录页面
- DashboardView.vue - 仪表板 (57KB)
- AccountsView.vue - 账户管理 (155KB)
- ApiKeysView.vue - API Key 管理 (175KB)
- ApiStatsView.vue - API 统计 (18KB)
- SettingsView.vue - 系统设置 (86KB)
- TutorialView.vue - 教程 (109KB)
- UserDashboardView.vue - 用户仪表板 (17KB)
- UserLoginView.vue - 用户登录 (7KB)
- UserManagementView.vue - 用户管理 (24KB)

**components/ (50+ 组件)**
- accounts/ - 账户管理组件
- admin/ - 管理员组件
- apikeys/ - API Key 管理组件
- apistats/ - API 统计组件
- common/ - 通用组件
- dashboard/ - 仪表板组件
- logs/ - 日志组件
- settings/ - 设置组件
- users/ - 用户管理组件

**stores/ (Pinia 状态管理)**
- auth.js - 认证状态
- user.js - 用户状态
- accounts.js - 账户状态
- apikeys.js - API Key 状态
- dashboard.js - 仪表板状态
- settings.js - 设置状态
- theme.js - 主题状态 (暗黑模式)
- notifications.js - 通知状态

**其他目录**
- router/ - 路由配置
- composables/ - 组合式 API
- utils/ - 工具函数
- config/ - 配置文件
- assets/ - 静态资源

### 3.3 技术栈

**核心框架:**
- Vue 3 (3.3.4)
- Vite (5.0.8)
- Vue Router (4.2.5)
- Pinia (2.1.7)

**UI 框架:**
- Element Plus (2.4.4)
- Tailwind CSS (3.3.6)
- Font Awesome (6.5.1)

**工具库:**
- Axios (1.6.2)
- Chart.js (4.4.0)
- Day.js (1.11.9)
- XLSX (0.18.5)

---

## 4. 部署方式

### 4.1 Docker 部署

**Dockerfile 结构:**
- 基础镜像: node:18-alpine
- 系统依赖: curl, dumb-init, sed
- 依赖安装: npm ci --only=production
- 前端产物: 需要本地预先构建
- 启动脚本: docker-entrypoint.sh
- 端口: 3000
- 健康检查: /health 端点

**Docker Compose 配置:**
- 服务: claude-relay
- 卷挂载: logs/, data/
- 环境变量: 完整的配置支持
- 网络: claude-relay-network
- 健康检查: 30s 间隔

### 4.2 启动脚本

docker-entrypoint.sh
- 环境变量检查
- 配置文件初始化
- Redis 连接验证
- 数据库迁移
- 日志目录创建
- 应用启动

---

## 5. 开发框架和技术栈

### 5.1 后端技术栈

**核心框架:**
- Node.js (>=18.0.0)
- Express (4.18.2)
- Redis (ioredis 5.3.2)

**认证和安全:**
- JWT (jsonwebtoken)
- bcryptjs (2.4.3)
- Helmet (7.1.0)
- CORS (2.8.5)

**API 集成:**
- @aws-sdk/client-bedrock-runtime
- google-auth-library (10.1.0)
- axios (1.6.0)
- https-proxy-agent (7.0.2)
- socks-proxy-agent (8.0.2)

**企业功能:**
- ldapjs (3.0.7)
- nodemailer (7.0.6)
- rate-limiter-flexible (5.0.5)

**日志和监控:**
- winston (3.11.0)
- winston-daily-rotate-file (4.7.1)
- morgan (1.10.0)

**工具库:**
- uuid (9.0.1)
- commander (11.1.0)
- inquirer (8.2.6)
- chalk (4.1.2)
- ora (5.4.1)
- table (6.8.1)
- string-similarity (4.0.4)
- compression (1.7.4)
- dotenv (16.3.1)

**开发工具:**
- nodemon (3.0.1)
- ESLint (8.53.0)
- Prettier (3.6.2)
- Jest (29.7.0)
- SuperTest (6.3.3)

### 5.2 前端技术栈

**核心框架:**
- Vue 3 (3.3.4)
- Vite (5.0.8)
- Vue Router (4.2.5)
- Pinia (2.1.7)

**UI 和样式:**
- Element Plus (2.4.4)
- Tailwind CSS (3.3.6)
- Font Awesome (6.5.1)
- PostCSS (8.4.32)
- Autoprefixer (10.4.16)

**数据和图表:**
- Axios (1.6.2)
- Chart.js (4.4.0)
- Day.js (1.11.9)
- XLSX (0.18.5)

**开发工具:**
- ESLint (8.55.0)
- Prettier (3.1.1)
- Playwright (1.55.0)
- Vite Plugin Checker (0.10.2)

---

## 6. 关键文件和配置

### 6.1 配置文件

- config/config.js - 主配置文件 (16KB)
- config/config.example.js - 配置示例
- config/pricingSource.js - 定价数据源
- config/claude-code-tools.json - Claude Code 工具配置

### 6.2 环境变量

.env 包含:
- 安全配置 (JWT_SECRET, ENCRYPTION_KEY)
- Redis 配置 (REDIS_HOST, REDIS_PORT, REDIS_PASSWORD)
- API 配置 (CLAUDE_API_URL, CLAUDE_API_VERSION)
- 功能开关 (USER_MANAGEMENT_ENABLED, LDAP_ENABLED, WEBHOOK_ENABLED)
- 其他配置 (LOG_LEVEL, PORT, NODE_ENV)

### 6.3 数据文件

- data/init.json - 管理员初始化数据

### 6.4 日志文件

- logs/claude-relay-*.log - 应用主日志
- logs/token-refresh-error.log - Token 刷新错误
- logs/webhook-*.log - Webhook 日志
- logs/http-debug-*.log - HTTP 调试日志

---

## 7. 项目规模统计

| 类别 | 数量 | 说明 |
|------|------|------|
| 后端服务文件 | 40+ | 账户管理、API 转发、调度器等 |
| 路由文件 | 15 | 各平台 API 路由 |
| 中间件 | 2 | 认证、浏览器回退 |
| 工具模块 | 24 | 日志、OAuth、代理等 |
| 前端组件 | 50+ | Vue 组件库 |
| 前端页面 | 10 | 主要视图 |
| 脚本工具 | 30+ | 管理、测试、迁移脚本 |
| 总代码行数 | 50,000+ | 后端 + 前端 |

---

## 8. 快速导航

### 常用文件位置

| 功能 | 文件位置 |
|------|---------|
| 应用入口 | src/app.js |
| 主配置 | config/config.js |
| API 路由 | src/routes/api.js |
| 管理路由 | src/routes/admin.js |
| 认证中间件 | src/middleware/auth.js |
| Redis 模型 | src/models/redis.js |
| 日志系统 | src/utils/logger.js |
| 前端入口 | web/admin-spa/src/main.js |
| 前端路由 | web/admin-spa/src/router/index.js |
| 状态管理 | web/admin-spa/src/stores/ |
| 主题配置 | web/admin-spa/src/stores/theme.js |

### 常用命令

```bash
# 开发
npm run dev                    # 开发模式
npm run build:web             # 构建前端

# 部署
npm run docker:build          # 构建镜像
npm run docker:up             # 启动容器

# 管理
npm run cli                    # CLI 工具
npm run service:start:daemon  # 后台启动
npm run service:logs:follow   # 实时日志

# 数据
npm run data:export           # 导出数据
npm run data:import           # 导入数据

# 代码质量
npm run lint                  # 代码检查
npm run format                # 代码格式化
```

---

## 总结

Claude Relay Service 是一个功能完整、架构清晰的企业级 AI API 中转服务。项目采用现代化的技术栈，包括 Node.js + Express 后端、Vue 3 + Vite 前端，支持 8 种 AI 平台，提供完整的账户管理、API Key 认证、成本追踪、用户管理等功能。项目代码组织规范，模块划分清晰，易于维护和扩展。
