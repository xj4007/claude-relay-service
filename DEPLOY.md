# 🚀 Docker 部署指南（本地编译版）

## ✅ 修改说明

为了避免在服务器上编译前端导致卡顿，已将 Dockerfile 改为使用本地预编译的前端产物。

### 已完成的修改：

1. **Dockerfile**：移除了前端构建阶段（frontend-builder）
2. **.dockerignore**：允许 `web/admin-spa/dist/` 目录被复制到镜像中

---

## 📋 部署步骤

### 1️⃣ 本地编译前端（Windows 本地）

```bash
# 安装前端依赖（首次需要）
npm run install:web

# 编译前端
npm run build:web
```

**检查编译产物：**
```bash
# 确认 dist 目录存在且包含文件
dir web\admin-spa\dist
```

应该能看到类似的文件：
- `index.html`
- `assets/` 目录（包含 CSS、JS 文件）

---

### 2️⃣ 修复 docker-entrypoint.sh 换行符（重要！）

Windows 上的文件使用 CRLF 换行符，需要转换为 Unix 的 LF 格式：

```bash
# 使用 Git Bash 或 WSL 执行
sed -i 's/\r$//' docker-entrypoint.sh

# 设置执行权限
chmod +x docker-entrypoint.sh
```

**或者在 Git 中配置自动转换：**
```bash
git config core.autocrlf input
git add docker-entrypoint.sh
git commit -m "fix: 修复换行符"
```

---

### 3️⃣ 上传到服务器

将以下文件/目录上传到服务器（例如 `/root/claude-relay-service/`）：

**必须上传的：**
- ✅ `Dockerfile`（��修改）
- ✅ `.dockerignore`（已修改）
- ✅ `docker-compose_us.yml`
- ✅ `docker-entrypoint.sh`（已修复换行符）
- ✅ `src/` 目录（后端代码）
- ✅ `config/` 目录
- ✅ `web/admin-spa/dist/` 目录（**本地编译好的前端**）
- ✅ `package.json`
- ✅ `package-lock.json`

**不需要上传的：**
- ❌ `node_modules/`
- ❌ `web/admin-spa/node_modules/`
- ❌ `web/admin-spa/src/`（前端源码不需要）
- ❌ `logs/`
- ❌ `.env`（在服务器上配置）

---

### 4️⃣ 服务器上部署

```bash
# 进入项目目录
cd /root/claude-relay-service/

# 再次确认换行符修复（如果在 Windows 上传后仍有问题）
sed -i 's/\r$//' docker-entrypoint.sh
chmod +x docker-entrypoint.sh

# 配置环境变量
cp .env.example .env
nano .env  # 编辑配置

# 构建并启动（不会编译前端，速度快！）
docker-compose -f docker-compose_us.yml up --build -d

# 查看日志
docker-compose -f docker-compose_us.yml logs -f claude-relay

# 检查服务状态
curl http://localhost:3000/health
```

---

## 🔧 关键文件检查清单

### 服务器上执行（部署前检查）：

```bash
# 1. 检查 dist 目录是否存在
ls -la web/admin-spa/dist/

# 2. 检查 docker-entrypoint.sh 文件格式
file docker-entrypoint.sh
# 应该显示：ASCII text, with LF line terminators
# 如果显示 CRLF，执行：sed -i 's/\r$//' docker-entrypoint.sh

# 3. 检查文件权限
ls -la docker-entrypoint.sh
# 应该有执行权限：-rwxr-xr-x

# 4. 检查 Dockerfile（不应有 frontend-builder 阶段）
head -5 Dockerfile
# 第一行应该是：# 🐳 主应用阶段（前端需在本地预先构建）
```

---

## 🎯 性能对比

| 方式 | 前端编译位置 | 构建时间 | 服务器负载 |
|------|--------------|----------|------------|
| ❌ 旧方式 | 服务器 Docker 内 | ~5-10分钟 | 高（CPU、内存） |
| ✅ 新方式 | 本地 Windows | ~30秒 | 低（仅安装后端依赖） |

---

## 🐛 常见问题

### 1. 前端页面 404 或空白

**原因**：dist 目录未正确复制到镜像中

**解决**：
```bash
# 检查本地是否有编译产物
dir web\admin-spa\dist

# 如果没有，重新编译
npm run build:web

# 检查 .dockerignore 是否注释了 web/admin-spa/dist/
cat .dockerignore | grep "web/admin-spa/dist"
# 应该是：# web/admin-spa/dist/  # 已注释
```

### 2. docker-entrypoint.sh: No such file or directory

**原因**：Windows 换行符问题

**解决**：
```bash
# 在服务器上执行
sed -i 's/\r$//' docker-entrypoint.sh
chmod +x docker-entrypoint.sh

# 重新构建
docker-compose -f docker-compose_us.yml up --build -d
```

### 3. 前端功能异常（API 调用失败）

**原因**：前端编译时使用了���误的 API 地址

**解决**：
```bash
# 检查前端环境变量
cat web/admin-spa/.env

# 重新编译
cd web/admin-spa
npm run build
cd ../..

# 重新上传 dist 目录到服务器
```

---

## 📝 更新前端流程

当前端代码有更新时：

```bash
# 1. 本地编译
npm run build:web

# 2. 上传 dist 目录到服务器
scp -r web/admin-spa/dist/ root@your-server:/root/claude-relay-service/web/admin-spa/

# 3. 服务器上重启服务
docker-compose -f docker-compose_us.yml restart claude-relay
```

**注意**：由于前端已编译成静态文件，如果只更新前端，甚至不需要重新构建镜像，直接替换 dist 目录并重启容器即可！

---

## ✅ 验证部署成功

```bash
# 1. 检查容器运行状态
docker ps | grep claude-relay

# 2. 检查健康状态
curl http://localhost:3000/health

# 3. 访问 Web 管理界面
# 浏览器打开：http://your-server-ip:3000/admin-next/

# 4. 查看日志
docker-compose -f docker-compose_us.yml logs -f claude-relay
```

---

## 🎉 总结

现在的部署流程：
1. ✅ **本地编译前端**（快速、无服务器压力）
2. ✅ **上传编译产物**（仅上传 dist 目录）
3. ✅ **服务器快速构建**（只安装后端依赖，~30秒完成）

**关键改进**：
- 🚀 构建速度提升 10 倍+
- 💰 节省服务器资源
- 🔧 前端更新更灵活（直接替换静态文件）
