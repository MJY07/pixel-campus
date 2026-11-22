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

    // 自检：确认静态资源在边缘确实可取（排查部署是否完整）
    if (url.pathname === '/api/selftest') {
      const files = ['/index.html', '/map/stardew.webp', '/audio/bell.mp3', '/map/t0_0.jpg', '/apple-touch-icon.png'];
      const out = {};
      for (const f of files) {
        try {
          const r = await env.ASSETS.fetch(new Request(new URL(f, url).toString(), request));
          out[f] = { status: r.status, type: r.headers.get('content-type'), len: Number(r.headers.get('content-length') || 0) };
          if (r.body) await r.body.cancel();
        } catch (e) {
          out[f] = { error: String(e && e.message) };
        }
      }
      return new Response(JSON.stringify(out), {
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
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
