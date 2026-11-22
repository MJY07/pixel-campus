/**
 * 像素校园 · Cloudflare Workers 入口
 *
 *   /ws           → 转发给 Durable Object（唯一的游戏世界实例）
 *   /api/health   → 同上，返回在线人数、分区、排行榜
 *   其它          → Workers Static Assets（public/ 目录）
 */

export { Game } from './game.js';

const WORLD = 'world';

function getWorld(env) {
  return env.GAME.get(env.GAME.idFromName(WORLD));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/ws' || url.pathname === '/ws/') {
      if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }
      return getWorld(env).fetch(request);
    }

    if (url.pathname === '/api/health') {
      return getWorld(env).fetch(request);
    }

    // 图标别名：部分浏览器/系统会直接找这个路径
    if (url.pathname === '/apple-touch-icon-precomposed.png') {
      const target = new URL('/apple-touch-icon.png', url);
      return env.ASSETS.fetch(new Request(target.toString(), request));
    }

    const res = await env.ASSETS.fetch(request);

    // 首页/入口必须每次校验，否则改版后用户看到的还是旧页面
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const headers = new Headers(res.headers);
      headers.set('cache-control', 'no-cache');
      return new Response(res.body, { status: res.status, headers });
    }
    return res;
  },
};
