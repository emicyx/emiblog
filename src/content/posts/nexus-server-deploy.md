---
title: 从本地到云端：Project Nexus 上线部署全记录
published: 2026-08-24
description: 智能体项目每次都要本地起 Docker 太麻烦，索性买了台京东云 2C4G 把 Nexus 常驻云端：git bundle 传代码不依赖 GitHub、IP 直连免备案、登录门 + Token 熔断保平安，附日备份/拨测收尾与两个实际踩过的坑。
image: ''
tags: [部署, Docker, 智能体, 云服务器]
category: 开发
draft: false
lang: ''
---

# 从本地到云端：Project Nexus 上线部署全记录

Nexus 是我这段时间在做的智能体项目：多 Agent 编排（Agents / Tools / Skills / Crews）、带向量检索的知识库、能抓网页的 Playwright 沙箱，前端是一张流式输出的聊天页。功能一直在长，但有个问题始终没解决——它只活在我的笔记本上。

每次想用都得：开电脑 → 起 Docker → 等三个容器 healthy → 浏览器进 localhost。用完还不能合盖，合了盖服务就没了；换台电脑、掏出手机，更是想都别想。对一个"随时可能聊两句"的 LLM 应用来说，这套仪式太笨重了。于是这个月下决心把它送到云上常驻：买一台轻量云服务器，Docker Compose 原样搬上去，IP 直连、免备案，先跑起来再说。

整个流程一条线：

```
买服务器 → 初始化 + 装 Docker → 代码上服务器 → 生产 .env → make up → 灌种子 → 开端口 → 备份拨测收尾
```

以下按时间线记录，踩过的坑集中在倒数第二节。

## 1. 前置准备

### 服务器与访问方式

京东云 2 核 4G 轻量云服务器，Ubuntu 24.04 LTS。内存给到 4G 是因为要同时跑 Postgres（带 pgvector/zhparser）、Redis、后端，外加一个装着 Chromium 的 Playwright 沙箱——2G 会很紧张。

境内机房绑 80/443 必须 ICP 备案，而备案以周计；纯 IP + 高位端口访问则完全不需要。所以我选了 IP 直连，域名和 HTTPS 留作以后的可选项。

### 密钥材料

上服务器之前先把所有密钥攒齐，一律 `openssl rand -hex 32` 现场生成，各不相同：

| 变量 | 用途 | 备注 |
|---|---|---|
| `QWEN_API_KEY` | 百炼 LLM/embedding | 自己的 key |
| `APP_API_KEY` | 后端 `/v1/*` 服务端鉴权 | 前端代理自动注入，浏览器不可见；**生产留空拒绝启动** |
| `APP_ACCESS_PASSWORD` | 访客登录密码（登录门） | 自己要记住的 |
| `SESSION_SECRET` | 会话 Cookie 签名加固 | `.env.example` 里没有，要手动加 |
| `POSTGRES_PASSWORD` / `APP_DB_PASSWORD` | DB superuser / 应用账号 | |
| `REDIS_PASSWORD` | Redis 密码 | 用 hex 生成，避开 URL 特殊字符转义问题 |
| `LLM_TOKEN_DAILY_BUDGET` | Token 日预算熔断 | 如 2000000；0 = 不限 |

> [!CAUTION]
> 禁止照抄 `.env.example` 里的占位串（`change-me-...` / `my-redis-secret` 之类）。占位串等于裸奔，全部换成本地生成的随机值。

### 上线加固欠账

真正部署之前还有一步：把"本地能跑"和"敢放到公网"之间的欠账还掉。这次上线前代码已经补齐了一批加固——中途断连自动终止（不白烧 LLM）、Token 日预算熔断、访客登录门、限流、健康检查、优雅停机。这些东西在 localhost 里全用不上，放到公网上一个都不能少。

### 控制台三件事

买完实例先做三件事：

1. 重置实例 root 密码并重启生效；
2. 记下公网 IP；
3. 安全组入方向**只放行 22/TCP**（SSH）。

> [!IMPORTANT]
> Web 端口等部署完成、验证无误后再开。先把 3000 放出去再慢慢配，等于把一扇还没装锁的门先敞开。

## 2. 服务器初始化

```bash
ssh root@公网IP
apt update && apt upgrade -y

# 2GB swap 当 OOM 保险（4GB 也建议加）
fallocate -l 2G /swapfile && chmod 600 /swapfile
mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

swap 是给意外时刻准备的：Chromium 抓网页的峰值内存不可控，真到 OOM 边缘时有 swap 顶一下，比容器被内核直接杀掉优雅得多。

## 3. 装 Docker：第一课是国内网络

```bash
apt install -y docker.io docker-compose-v2
systemctl enable --now docker
docker compose version
```

然后大概率撞上第一课：Docker Hub 拉镜像超时（`dial tcp ... i/o timeout`）。配镜像加速：

```bash
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'EOF'
{"registry-mirrors": ["https://docker.m.daocloud.io", "https://docker.1ms.run", "https://docker.1panel.live"]}
EOF
systemctl restart docker
```

Nexus 需要的基础镜像共 4 个：`redis:7-alpine`、`python:3.11-slim`、`node:20-alpine`、`pgvector/pgvector:pg16`。

> [!TIP]
> 公共加速源时有失灵，全挂的时候还有个兜底——带前缀拉下来再改回原名，四个镜像同理：
>
> ```bash
> docker pull docker.m.daocloud.io/library/redis:7-alpine
> docker tag docker.m.daocloud.io/library/redis:7-alpine redis:7-alpine
> ```

## 4. 代码上服务器：git bundle

私人项目，仓库没有放到 GitHub，服务器拉代码就成了问题。用 git 自带的 bundle 解决——把整个仓库打成一个文件 scp 上去。

Windows 本机 PowerShell：

```powershell
# 项目目录下
git bundle create "$env:TEMP\nexus.bundle" --all
scp "$env:TEMP\nexus.bundle" root@公网IP:/opt/
git remote add server ssh://公网IP/opt/nexus.git   # 一次性，以后直接推
```

服务器：

```bash
git clone /opt/nexus.bundle /opt/myAgent
git init --bare /opt/nexus.git
```

这样一来服务器上还有一个裸仓库当远程，以后的更新就是一条流水线：本地 `git push server master`，服务器上 `cd /opt/myAgent && git pull /opt/nexus.git master && make rebuild`。不依赖任何托管平台，也不依赖服务器访问 GitHub 的网络质量——国内机器 clone GitHub 的痛苦，懂的都懂。

## 5. 生产 `.env`

```bash
cd /opt/myAgent && cp .env.example .env && nano .env
```

必填项：

```
QWEN_API_KEY=sk-...
APP_ENV=production
APP_API_KEY=<随机>
APP_ACCESS_PASSWORD=<登录密码>
SESSION_SECRET=<随机，手动新增此行>
POSTGRES_PASSWORD=<强口令>
APP_DB_PASSWORD=<强口令>
REDIS_PASSWORD=<随机hex>
REDIS_URL=redis://:<REDIS_PASSWORD同值>@redis:6379/0   # 主机名必须是 redis，不是 localhost！
LLM_TOKEN_DAILY_BUDGET=2000000
```

几个值得展开的点：

- **APP_API_KEY** 是后端 `/v1/*` 的服务端鉴权，由前端代理自动注入，浏览器里看不到；生产环境留空会直接拒绝启动——这是故意的，防止有人不带钥匙就把服务开到公网。
- **APP_ACCESS_PASSWORD** 是登录门的密码，进聊天页要输的那个。
- **SESSION_SECRET** 负责 Cookie 签名加固，示例文件里没有这一项，记得手动加。
- **LLM_TOKEN_DAILY_BUDGET** 是 Token 日预算熔断，我设了 200 万，防止哪天被人薅走百万级 token。

> [!NOTE]
> 容器里的 `localhost` 既不是 Redis 也不是 Postgres——compose 网络里连接串主机名一律用服务名（`redis` / `postgres`）。示例配置注释里写的 `localhost` 是给本地裸跑看的，照抄必炸。这个坑我也没有幸免，见踩坑记录。

## 6. 启动与验证

```bash
make up                        # = docker compose up --build -d，首次要几分钟（拉镜像 + 装 Chromium）
docker compose ps              # 等三个容器 healthy（backend 有 30s 启动宽限）
curl http://127.0.0.1:8000/health
# 期望：{"status":"ok","checks":{"db":"ok","redis":"ok"}}
```

首次启动会自动完成一整串初始化：PG 空 Volume 建库（pgvector/zhparser 扩展 + 最小权限应用账号）→ 自动建表 → LLM 预热 → 沙箱清理调度。全程不需要手动迁移，对"一个人当整个运维部"的场景非常友好。

排障入口：`docker compose logs backend --tail 50`，每条日志带 request-id，能把一次请求的全链路串起来。

### 可选：灌入内置配置

生产默认不灌种子（`SEED_DEMO_DATA=false`），这是数据卫生层面的设计：线上环境不自带任何演示数据，Agents、Tools 等列表初始为空属正常现象。如果需要内置的那套 Agents / Tools / Skills / Schemas / Crews，跑一条幂等命令即可：

```bash
docker compose exec backend python -c "import asyncio; from app.db.seed import ensure_seed; asyncio.run(ensure_seed())"
```

知识库文档不在种子里，去聊天页用文档上传功能重新灌真实语料就行，embedding 成本很低。

## 7. 开放访问：二选一

**方案 A：IP 直连（免备案，本次采用）**

安全组放行 TCP 3000，访问 `http://公网IP:3000`，自动跳转 `/login`，输 `APP_ACCESS_PASSWORD` 进入。

> [!CAUTION]
> 这是明文 HTTP，别在公共 WiFi 下使用。要彻底解决得上方案 B。

**方案 B：域名 + HTTPS（需 ICP 备案）**

备案下来之后：`apt install caddy`，Caddyfile 里 `/health` 反代 `127.0.0.1:8000`、其余走 `127.0.0.1:3000`；安全组放行 80/443；compose 里把 3000 改绑回 `127.0.0.1:3000:3000`，不再直接对外。

> [!IMPORTANT]
> 如果用 Nginx 而不是 Caddy，有两项必须改：`proxy_buffering off`（否则 SSE 流式输出被缓冲，前端看不到逐字吐出的效果）和 `proxy_read_timeout 3600s`（长对话不被中途掐断）。

## 8. 部署日收尾：运维三件套

服务跑起来只是上半场，三件事让它能无人值守地活着：

```bash
# 1. 数据库每日备份（crontab -e），保留 14 天
0 4 * * * cd /opt/myAgent && docker compose exec -T postgres pg_dump -U nexus nexus | gzip > /var/backups/nexus-$(date +\%F).sql.gz && find /var/backups -name "nexus-*.sql.gz" -mtime +14 -delete
```

2. **拨测**：UptimeRobot 盯 `http://IP:3000`，挂了发邮件。走方案 B 的话盯 `https://域名/health`，能真探 DB 和 Redis 的状态。
3. **巡检**：日常 `make logs` / `docker compose ps`，指标看 `curl -H "X-API-Key: ..." http://127.0.0.1:8000/metrics`。

另外代码里内置了两条自动告警：磁盘超 85%、Token 用量超日预算 80% 都会打告警日志，沙箱产物 7 天自动清理——4G 的小机器，磁盘和内存都得有人盯着。

## 9. 上线验证清单

对外可访问之后，把这张单子过一遍：

- [ ] 未登录 `curl http://IP:3000/v1/agents` → 401（登录门生效）
- [ ] 错误密码 401，正确密码进入聊天页
- [ ] 外网 telnet 8000 不通（后端只留 loopback）；`/docs` 404（生产关闭）
- [ ] `.env` 无占位密钥：`grep -E "^(APP_API_KEY|APP_ACCESS_PASSWORD|SESSION_SECRET)" .env`
- [ ] 发消息：思考步骤 + 流式回答正常，刷新后历史还在
- [ ] 网页抓取任务正常（出网 + Playwright）
- [ ] 中途断开回答，后端日志出现 `run_cancelled`（不再白烧 LLM）
- [ ] 需要内置配置的话种子已灌（/config 各列表非空）、知识库文档已上传
- [ ] 备份 cron 已加、拨测已配

## 10. 踩坑记录

两个坑，全部实际踩过：

**1. Docker Hub 拉镜像超时。** 现象是 `dial tcp ... i/o timeout`，纯网络问题。解法就是第三节 daemon.json 的镜像加速；加速源集体失灵时用"前缀拉取再改回原名"兜底。

**2. Redis ConnectionError。** `.env.example` 的示例注释写的是 `localhost`，而容器网络里这个名字指向容器自己，不是 Redis 容器。连接串主机名一律用 compose 服务名。这是两个坑里最浪费时间的一个——报错信息只有一句"连不上 Redis"，很难第一时间想到是配置注释误导。

## 11. 日常运维速查

| 场景 | 操作 |
|---|---|
| 更新代码 | 本地 `git push server master` → 服务器 `git pull /opt/nexus.git master && make rebuild` |
| 回滚 | 服务器 `git checkout <旧提交> . && make rebuild`（数据在 pgdata 卷和 `./backend/data`，不受影响） |
| 停机 | `docker compose down`（优雅停机：等在跑的对话收尾，最长 60s） |
| 看日志 | `make logs` |
| 进数据库 | `make psql` |

## 后续加固待办

不阻塞上线，但记在日程上：

- 登录接口防爆破（每 IP 每分钟限 5 次）
- 上了 HTTPS 之后会话 Cookie 加 `secure` 标志
- `SESSION_SECRET` 补进 `.env.example` 模板
- 域名备案完成后切方案 B（HTTPS）

## 结语

从"每次用都要本地起一遍"到"任何设备打开浏览器输个密码就能用"，部署流程本身不算复杂，真正花时间的是两件事：上线前把安全欠账还清，以及踩上面那两个坑。公网和 localhost 的区别就在这里——本地能跑只是及格，敢被陌生人扫描才算上线。
