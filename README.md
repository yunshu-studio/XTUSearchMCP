# 湘潭大学统一搜索 MCP

面向湘潭大学官网、学院网站和就业信息网的统一搜索服务，可通过 MCP 接入支持工具调用的 AI 客户端。

一个入口即可搜索多个校内官方信息源，不需要分别打开不同网站查找通知、新闻、教学信息或招聘信息。

## 功能

- **统一搜索**：一次查询多个湘潭大学官方站点
- **按来源筛选**：可限定学院、部门或指定网站
- **语义搜索**：支持更接近自然语言的检索方式
- **正文读取**：搜索后可继续获取文章正文
- **数据源管理**：提供网页管理界面，可添加、启用、停用和重新索引站点
- **定时更新**：已收录内容会自动更新
- **访问控制**：MCP 接口使用令牌保护，管理页面使用独立账号密码

## MCP 工具

服务提供 3 个工具：

| 工具 | 作用 |
| --- | --- |
| `search` | 搜索已启用的湘潭大学信息源 |
| `get_article` | 获取指定文章的正文内容 |
| `list_sources` | 查看当前可用的信息源 |

`search` 支持以下模式：

- `live`：优先查询网站当前内容
- `semantic`：按语义相关性搜索
- `hybrid`：结合实时搜索和语义搜索

## 连接到 MCP

部署完成后，MCP 地址为：

```text
https://你的域名或 Workers 地址/mcp
```

请求需要携带访问令牌：

```http
Authorization: Bearer <MCP_TOKEN>
```

在支持自定义 HTTP MCP 的客户端中填写服务地址，并配置上述 Bearer Token 即可使用。

## 管理页面

打开：

```text
https://你的域名或 Workers 地址/admin
```

使用部署时设置的管理员账号和密码登录。

你可以在管理页面中：

- 查看已接入的信息源
- 添加新的湘潭大学站点
- 检查站点是否可用
- 启用或停用信息源
- 重新建立搜索数据

## 自行部署

### 需要准备

- Node.js
- Cloudflare 账号
- 已启用 Workers、D1、R2、Queues、Vectorize 和 Workers AI

### 1. 安装依赖

```bash
npm install
```

### 2. 登录 Cloudflare

```bash
npx wrangler login
```

### 3. 创建所需资源

Windows PowerShell：

```powershell
.\scripts\bootstrap-fresh-account.ps1
```

Linux / macOS：

```bash
bash ./scripts/bootstrap-fresh-account.sh
```

创建完成后，将命令返回的 D1 `database_id` 填入 `wrangler.jsonc`。

### 4. 初始化数据库

```bash
npx wrangler d1 migrations apply xtu-search-mcp --remote
```

### 5. 设置访问凭据

Windows PowerShell：

```powershell
.\scripts\set-secrets.ps1
```

Linux / macOS：

```bash
bash ./scripts/set-secrets.sh
```

需要设置：

- `ADMIN_USERNAME`：管理页面用户名
- `ADMIN_PASSWORD`：管理页面密码
- `SESSION_SECRET`：用于保护登录会话的随机字符串，建议至少 32 字节
- `MCP_TOKEN`：MCP 客户端访问令牌

### 6. 部署

```bash
npm run deploy
```

部署完成后即可通过 `/admin` 管理信息源，通过 `/mcp` 提供 MCP 搜索服务。

## 搜索范围

项目面向 `xtu.edu.cn` 下的湘潭大学官方站点，并内置湘潭大学就业信息网支持。

不同学院和部门网站的搜索页面并不完全一致，本项目会尽可能自动识别其可用搜索方式；对于没有可直接使用搜索入口的站点，也可以建立本地搜索数据。

## 安全建议

- 不要把 `MCP_TOKEN`、管理员密码或 `SESSION_SECRET` 写入仓库
- 建议为公开部署配置自定义域名和 HTTPS
- `MCP_TOKEN` 应使用足够长的随机字符串
- 如果只供自己使用，请不要公开分享访问令牌

## 说明

本项目用于统一检索湘潭大学公开网站信息。搜索结果以原网站内容为准，项目与湘潭大学官方无隶属关系。
