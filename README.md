# 像素校园 · 河北郑口中学

多人联机像素校园小游戏。Node.js 服务端 + 原生 Canvas 前端，WebSocket 实时同步。

## 本地运行

```bash
npm install
npm start          # 默认 3000 端口
PORT=8080 npm start
```

打开 `http://localhost:3000` 即可。

## 部署

托管平台要求监听 `0.0.0.0` 与 `process.env.PORT`，本项目已满足。

- 安装命令：`npm install`（有 lock 文件时可用 `npm ci`）
- 构建命令：留空
- 启动命令：`node server.js`
- 运行端口：由平台通过 `PORT` 环境变量注入

## 目录

| 路径 | 说明 |
|---|---|
| `server.js` | HTTP + WebSocket 服务端，房间状态、战斗判定、计分、排行榜 |
| `public/index.html` | 游戏前端（单文件，Canvas 渲染） |
| `test-protocol.mjs` | 协议回归测试，覆盖进房、移动、攻击、Boss 击倒、命中率 |

## 玩法要点

- 大厅 → A 区（卫星版）/ 星露谷风（像素风重绘）/ B 区（像素版）
- 三个分区共用同一套玩法：攻击、睡觉回血、计分、Boss 战；星露谷风沿用 A 区的碰撞体
- 学生：攻击、睡觉回血、得分；老师（Boss）：1000 血、四种技能
- **Boss 被击倒后转为学生**，不再复活成 Boss
- **弓箭命中率 70%**，受朝向与射程限制

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 3000 | 监听端口 |
| `CD_SCALE` | 1 | 冷却倍率，压测用，生产保持 1 |
