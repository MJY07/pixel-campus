/**
 * 像素校园 · 河北郑口中学 —— 联机服务端
 *
 * 单进程 Node HTTP + WebSocket，前端在 public/index.html。
 * 协议完全对齐原前端（181KB 单文件），消息类型见 README。
 *
 * 关键设计
 *  - 三个场景：lobby（大厅）/ exp（A 区卫星版）/ gen（B 区像素版），只在同区互见
 *  - 老师玩家即 Boss（1000 血），被击倒后变回学生（不再复活成 Boss）
 *  - 弓箭命中率 70%，长剑近战固定命中
 *  - 排行榜按名字累计，落盘到 data/scores.json
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';

/* ============================== 常量 ============================== */

const ZONES = {
  lobby: { w: 1024, h: 1000, spawn: { x: 512, y: 520 }, name: '大厅' },
  exp: { w: 2304, h: 1898, spawn: { x: 120, y: 1338 }, name: 'A 区（卫星版）' },
  gen: { w: 2304, h: 1216, spawn: { x: 120, y: 760 }, name: 'B 区（像素版）' },
};

const MAX_STUDENT_HP = 100;
const MAX_BOSS_HP = 1000;
const REVIVE_MS = 5000;

const DMG_TAP = 20;
const DMG_CHARGE = 50;
const MELEE_RANGE = 96;
const MELEE_HALF_ARC = Math.PI / 2.6;

const BOW_RANGE = 540;
const BOW_HIT_RATE = 0.7;      // 需求：弓箭命中率 70%
const BOW_COOLDOWN = 700;

const SKILL_CD = { smash: 1500, bolt: 2800, burst: 11000, quake: 9000 };
const SKILL_DMG = { smash: 40, bolt: 26, burst: 20, quake: 34 };

const DIR_VEC = [[0, 1], [-1, 0], [1, 0], [0, -1]];
const MAX_NAME = 12;
const MAX_CHAT = 120;
const MOVE_GAP = 28;
const CD_SCALE = Number(process.env.CD_SCALE || 1);   // 压测用，生产保持 1

const DATA_DIR = path.join(__dirname, 'data');
const SCORE_FILE = path.join(DATA_DIR, 'scores.json');

/* ============================== 工具 ============================== */

const now = () => Date.now();
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v, fb, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) ? clamp(n, lo, hi) : fb;
};
const cleanText = (v, max) =>
  String(v ?? '').replace(/[\r\n\t<>]/g, '').trim().slice(0, max);
const rid = () => 'p' + now().toString(36) + crypto.randomBytes(3).toString('hex');

/* ============================== 排行榜持久化 ============================== */

let scores = new Map();          // name -> score
let admins = new Set(
  String(process.env.ADMIN_NAMES || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
);

function loadScores() {
  try {
    const raw = JSON.parse(fs.readFileSync(SCORE_FILE, 'utf8'));
    for (const [k, v] of Object.entries(raw.scores || {})) scores.set(k, Number(v) || 0);
    for (const n of raw.admins || []) admins.add(n);
  } catch { /* 首次运行没有文件 */ }
}
let saveTimer = null;
function saveScoresSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(SCORE_FILE, JSON.stringify({
        scores: Object.fromEntries(scores),
        admins: [...admins],
      }));
    } catch (e) { console.error('[score] save failed', e.message); }
  }, 1200);
}
function addScore(name, delta) {
  const s = (scores.get(name) || 0) + delta;
  scores.set(name, s);
  saveScoresSoon();
  return s;
}

/* ============================== 房间状态 ============================== */

/** @type {Map<string, any>} id -> player */
const players = new Map();
/** @type {Map<string, string>} cid -> id （同一浏览器只保留一条连接） */
const cidIndex = new Map();

let maintaining = process.env.MAINTAIN === '1';

function zoneOf(p) { return ZONES[p.zone] || ZONES.lobby; }

function isBoss(p) { return p.role === 'teacher' && !p.bossDead; }

function publicOf(p) {
  return {
    id: p.id, name: p.name, x: Math.round(p.x), y: Math.round(p.y),
    dir: p.dir, color: p.color, skin: p.skin, anim: p.anim,
    run: !!p.run, bike: !!p.bike, sit: !!p.sit, jump: Math.round(p.jump || 0),
    wave: !!p.wave,
  };
}

function bossOf(p) {
  return {
    id: p.id, owner: p.id, name: p.name, zone: p.zone,
    x: Math.round(p.x), y: Math.round(p.y), dir: p.dir,
    hp: p.bossHp ?? 0, maxHp: MAX_BOSS_HP, phase: p.phase || 1,
    dead: !!p.dead, cast: p.cast || null,
    cdL: cdLeft(p),
  };
}

/** 技能冷却剩余毫秒（前端按剩余时间画遮罩，不能给绝对时间戳） */
function cdLeft(p) {
  const t = now();
  const src = p.skillCd || {};
  const out = {};
  for (const k of Object.keys(SKILL_CD)) out[k] = Math.max(0, (src[k] || 0) - t);
  return out;
}

function rosterIn(zone, exceptId) {
  const list = [];
  for (const p of players.values()) {
    if (!p.joined || p.zone !== zone) continue;
    if (p.id === exceptId) continue;
    if (p.role === 'teacher') continue;   // 老师只通过 bosses 下发，避免重复渲染
    list.push(publicOf(p));
  }
  return list;
}

function bossesIn(zone) {
  const list = [];
  for (const p of players.values()) {
    if (!p.joined || p.zone !== zone) continue;
    if (p.role !== 'teacher') continue;
    list.push(bossOf(p));
  }
  return list;
}

function onlineCount() {
  let n = 0;
  for (const p of players.values()) if (p.joined) n++;
  return n;
}

function zoneCount(zone) {
  let n = 0;
  for (const p of players.values()) if (p.joined && p.zone === zone) n++;
  return n;
}

function rankList() {
  const rows = [];
  for (const [name, score] of scores) {
    const online = [...players.values()].some((p) => p.joined && p.name === name);
    rows.push({ name, score, admin: admins.has(name), online });
  }
  rows.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return rows;
}

/* ============================== 消息发送 ============================== */

function send(p, obj) {
  if (!p || !p.ws || p.ws.readyState !== 1) return;
  try { p.ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
}

function broadcastZone(zone, obj, exceptId) {
  const s = JSON.stringify(obj);
  for (const p of players.values()) {
    if (!p.joined || p.zone !== zone || p.id === exceptId) continue;
    if (!p.ws || p.ws.readyState !== 1) continue;
    try { p.ws.send(s); } catch { /* ignore */ }
  }
}

function broadcastAll(obj, exceptId) {
  const s = JSON.stringify(obj);
  for (const p of players.values()) {
    if (!p.joined || p.id === exceptId) continue;
    if (!p.ws || p.ws.readyState !== 1) continue;
    try { p.ws.send(s); } catch { /* ignore */ }
  }
}

function announceOnline() {
  broadcastAll({ t: 'online', n: onlineCount(), all: onlineCount() });
  broadcastAll({ t: 'alln', n: onlineCount() });
}

/* ============================== 战斗 ============================== */

function setHp(p, hp) {
  p.hp = clamp(Math.round(hp), 0, p.maxHp);
  return p.hp;
}

function pushScores(p) {
  send(p, { t: 'you', name: p.name, score: scores.get(p.name) || 0, admin: admins.has(p.name) });
}

/** 对某个玩家造成伤害；返回是否被击倒 */
function damage(target, dmg, by, opts = {}) {
  if (!target || target.dead || !target.joined) return false;

  /* Boss：血量单独存 bossHp，不能写进 hp，否则会把老师自己的学生血条顶成 1000 */
  if (target.role === 'teacher') {
    target.bossHp = Math.max(0, (target.bossHp ?? MAX_BOSS_HP) - dmg);
    const hp = target.bossHp;
    broadcastZone(target.zone, {
      t: 'bhit',
      id: target.id, hp, maxHp: MAX_BOSS_HP, dmg,
      x: Math.round(target.x), y: Math.round(target.y),
      charge: opts.charge ? 1 : 0,
    });
    if (target.phase !== 2 && hp > 0 && hp <= MAX_BOSS_HP * 0.5) {
      target.phase = 2;
      broadcastZone(target.zone, { t: 'bphase', id: target.id });
    }
    if (hp <= 0) { onDown(target, by); return true; }
    return false;
  }

  const before = target.hp;
  const hp = setHp(target, target.hp - dmg);
  broadcastZone(target.zone, {
    t: 'hit',
    target: target.id,
    hp,
    dmg,
    x: Math.round(target.x),
    y: Math.round(target.y),
    charge: opts.charge ? 1 : 0,
    byId: by ? by.id : undefined,
    byName: by ? by.name : undefined,
  });

  if (before > 0 && hp <= 0) {
    onDown(target, by);
    return true;
  }
  return false;
}

/** 击倒结算：学生 5 秒复活；老师变回学生（需求） */
function onDown(target, by) {
  target.dead = true;
  target.hp = 0;
  target.atkCd = 0;
  target.sleep = false;

  if (target.role === 'teacher') {
    // ===== Boss 被击败 → 变回学生，不再复活成 Boss（业主需求） =====
    target.bossDead = true;
    target.role = 'student';
    target.maxHp = MAX_STUDENT_HP;
    target.bossHp = 0;
    target.phase = 1;
    target.skillCd = { smash: 0, bolt: 0, burst: 0, quake: 0 };
    target.dead = false;
    target.hp = MAX_STUDENT_HP;
    target.reviveAt = 0;

    const gained = 10;
    const score = by ? addScore(by.name, gained) : 0;

    broadcastZone(target.zone, {
      t: 'bossdown',
      id: target.id,
      by: by ? by.id : '',
      byName: by ? by.name : '',
      name: target.name,
      score: gained,
    });
    // 本人：切回学生 UI
    send(target, { t: 'teacherEnd', msg: '你被击败了，已变回学生' });
    send(target, { t: 'you', name: target.name, score: scores.get(target.name) || 0, admin: admins.has(target.name) });
    // 其他人：把他当作普通玩家重新加入
    broadcastZone(target.zone, { t: 'join', p: publicOf(target) }, target.id);
    // 广播新的 Boss 列表（此时已无他）
    broadcastZone(target.zone, { t: 'bs', list: bossesIn(target.zone) });
    if (by) pushScores(by);
    return;
  }

  // ===== 学生被击倒 =====
  const gained = 1;
  const score = by ? addScore(by.name, gained) : 0;

  broadcastZone(target.zone, {
    t: 'down',
    id: target.id,
    name: target.name,
    hp: 0,
    x: Math.round(target.x),
    y: Math.round(target.y),
    byId: by ? by.id : '',
    byName: by ? by.name : '',
    score: by ? score : 0,
    reviveIn: Math.round(REVIVE_MS / 1000),
    boss: by && by.role === 'teacher' ? 1 : 0,
  });
  if (by) pushScores(by);

  target.reviveAt = now() + REVIVE_MS;
  setTimeout(() => {
    const p = players.get(target.id);
    if (!p || !p.joined) return;
    if (p.role === 'teacher') return;
    p.dead = false;
    p.hp = p.maxHp;
    p.reviveAt = 0;
    const at = zoneOf(p).spawn;
    p.x = at.x; p.y = at.y;
    send(p, { t: 'revive', hp: p.hp, x: Math.round(p.x), y: Math.round(p.y) });
    broadcastZone(p.zone, {
      t: 'rise', id: p.id, hp: p.hp,
      x: Math.round(p.x), y: Math.round(p.y),
    }, p.id);
  }, REVIVE_MS);
}

/** 找一个可被攻击的目标 */
function findTargets(attacker, filter) {
  const out = [];
  for (const p of players.values()) {
    if (!p.joined || p.zone !== attacker.zone || p.id === attacker.id || p.dead) continue;
    if (!p.pvp) continue;
    if (filter && !filter(p)) continue;
    out.push(p);
  }
  return out;
}

function attack(p, msg) {
  if (p.dead || !p.joined) return;
  if (p.zone === 'lobby') return;               // 大厅不能打
  if (!p.pvp) return;

  const t0 = now();
  const bow = msg.weapon === 'bow' || p.weapon === 'bow';
  const cd = bow ? BOW_COOLDOWN : (msg.charge ? 560 : 300);
  if (t0 < (p.atkCd || 0)) return;
  p.atkCd = t0 + cd * CD_SCALE;

  const charge = bow ? 0 : (msg.charge ? 1 : 0);
  const dir = num(msg.dir, p.dir, 0, 3) | 0;
  p.dir = dir;

  broadcastZone(p.zone, { t: 'swing', id: p.id, charge }, p.id);

  if (bow) {
    const [dx, dy] = DIR_VEC[dir];
    const len = Math.hypot(dx, dy) || 1;
    const tx = p.x + (dx / len) * BOW_RANGE;
    const ty = p.y + (dy / len) * BOW_RANGE;
    // 弹道表现：同区所有人都能看到箭飞出去
    broadcastZone(p.zone, {
      t: 'shoot',
      fx: Math.round(p.x), fy: Math.round(p.y),
      tx: Math.round(tx), ty: Math.round(ty),
    }, p.id);

    // 命中判定：先筛出弹道附近的候选，再按 70% 概率决定是否命中
    const targets = findTargets(p, (q) => {
      const rx = q.x - p.x, ry = q.y - p.y;
      const proj = rx * (dx / len) + ry * (dy / len);
      if (proj < 8 || proj > BOW_RANGE) return false;
      const perp = Math.abs(rx * (-dy / len) + ry * (dx / len));
      return perp <= 34;
    });
    if (!targets.length) {
      send(p, { t: 'miss', x: Math.round(p.x), y: Math.round(p.y), tx: Math.round(tx), ty: Math.round(ty) });
      return;
    }

    targets.sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y));
    const target = targets[0];
    if (Math.random() > BOW_HIT_RATE) {          // 30% 射空
      send(p, { t: 'miss', x: Math.round(p.x), y: Math.round(p.y), tx: Math.round(tx), ty: Math.round(ty) });
      return;
    }

    damage(target, DMG_TAP, p, { charge: false });
    return;
  }

  // 近战：扇形范围内全中
  const [dx, dy] = DIR_VEC[dir];
  const len = Math.hypot(dx, dy) || 1;
  const dmg = charge ? DMG_CHARGE : DMG_TAP;
  const targets = findTargets(p, (q) => {
    const rx = q.x - p.x, ry = q.y - p.y;
    const d = Math.hypot(rx, ry);
    if (d > MELEE_RANGE) return false;
    const cos = (rx * dx + ry * dy) / (d * len || 1);
    return Math.acos(clamp(cos, -1, 1)) <= MELEE_HALF_ARC;
  });
  for (const t of targets) damage(t, dmg, p, { charge });
}

/* ---------- 老师技能 ---------- */

function castSkill(p, k) {
  if (p.role !== 'teacher' || p.dead) return;
  if (!SKILL_CD[k]) return;
  const t0 = now();
  p.skillCd = p.skillCd || {};
  if (t0 < (p.skillCd[k] || 0)) {
    send(p, { t: 'bmsg', ok: 0, msg: '技能冷却中' });
    return;
  }
  p.skillCd[k] = t0 + SKILL_CD[k] * (p.phase === 2 ? 0.8 : 1) * CD_SCALE;

  const dmg = Math.round(SKILL_DMG[k] * (p.phase === 2 ? 1.3 : 1));
  const zone = p.zone;

  if (k === 'quake') {
    const r = 190;
    broadcastZone(zone, { t: 'bcast', k: 'quake', x: Math.round(p.x), y: Math.round(p.y), r });
    for (const t of findTargets(p, (q) => Math.hypot(q.x - p.x, q.y - p.y) <= r)) {
      damage(t, dmg, p);
    }
    return;
  }

  if (k === 'smash') {
    const [dx, dy] = DIR_VEC[p.dir] || [0, 1];
    broadcastZone(zone, { t: 'bcast', k: 'smash', x: Math.round(p.x), y: Math.round(p.y), dir: p.dir });
    const len = Math.hypot(dx, dy) || 1;
    for (const t of findTargets(p, (q) => {
      const rx = q.x - p.x, ry = q.y - p.y;
      const d = Math.hypot(rx, ry);
      if (d > 150) return false;
      const cos = (rx * dx + ry * dy) / (d * len || 1);
      return Math.acos(clamp(cos, -1, 1)) <= Math.PI / 2.4;
    })) damage(t, dmg, p);
    return;
  }

  // bolt / burst：直线弹幕
  const count = k === 'burst' ? 12 : 4;
  const range = k === 'burst' ? 480 : 420;
  const arrows = [];
  for (let i = 0; i < count; i++) {
    const ang = k === 'burst'
      ? (Math.PI * 2 * i) / count
      : (Math.PI / 2) * i + Math.PI / 4;
    const ex = p.x + Math.cos(ang) * range;
    const ey = p.y + Math.sin(ang) * range;
    arrows.push({ x0: Math.round(p.x), y0: Math.round(p.y), x1: Math.round(ex), y1: Math.round(ey) });
    for (const t of findTargets(p, (q) => {
      const rx = q.x - p.x, ry = q.y - p.y;
      const proj = rx * Math.cos(ang) + ry * Math.sin(ang);
      if (proj < 10 || proj > range) return false;
      const perp = Math.abs(rx * -Math.sin(ang) + ry * Math.cos(ang));
      return perp <= 30;
    })) damage(t, dmg, p);
  }
  broadcastZone(zone, {
    t: 'bcast', k, x: Math.round(p.x), y: Math.round(p.y),
    arrows, r: k === 'burst' ? 70 : 56,
  });
}

/* ============================== 进出场景 ============================== */

function joinZone(p, zoneKey) {
  const z = ZONES[zoneKey] ? zoneKey : 'lobby';
  const from = p.zone;
  if (from && from !== z) {
    broadcastZone(from, { t: 'leave', id: p.id, name: p.name });
    broadcastZone(from, { t: 'bs', list: bossesIn(from) });
  }
  p.zone = z;
  const sp = ZONES[z].spawn;
  p.x = sp.x;
  p.y = sp.y;
  p.dead = false;
  p.hp = MAX_STUDENT_HP;
  p.atkCd = 0;
  p.sleep = false;

  send(p, {
    t: 'zoned',
    zone: z,
    zoneName: ZONES[z].name,
    x: Math.round(p.x),
    y: Math.round(p.y),
    hp: p.hp,
    players: rosterIn(z, p.id),
    n: zoneCount(z),
    all: onlineCount(),
    role: p.role,
    bosses: bossesIn(z),
  });
  broadcastZone(z, { t: 'join', p: publicOf(p) }, p.id);
  broadcastZone(z, { t: 'bs', list: bossesIn(z) });
}

/* ============================== 连接处理 ============================== */

function handleJoin(ws, m) {
  const name = cleanText(m.name, MAX_NAME) || '同学';
  const cid = cleanText(m.cid, 40);

  // 同一浏览器重连：踢掉旧连接，避免一个显示成两个
  if (cid && cidIndex.has(cid)) {
    const oldId = cidIndex.get(cid);
    const old = players.get(oldId);
    if (old) {
      try { old.ws && old.ws.close(1000, 'replaced'); } catch { /* ignore */ }
      players.delete(oldId);
    }
    cidIndex.delete(cid);
  }

  const role = m.role === 'teacher' ? 'teacher' : 'student';
  const zone = ZONES[m.zone] ? m.zone : 'lobby';
  const p = {
    id: rid(),
    cid,
    ws,
    joined: true,
    name,
    role,
    admin: admins.has(name),
    zone,
    x: num(m.x, ZONES[zone].spawn.x, 0, ZONES[zone].w),
    y: num(m.y, ZONES[zone].spawn.y, 0, ZONES[zone].h),
    dir: num(m.dir, 0, 0, 3) | 0,
    color: /^#[0-9a-fA-F]{6}$/.test(String(m.color || '')) ? m.color : '#4a90d9',
    skin: num(m.skin, 0, 0, 2) | 0,
    anim: 'idle', run: false, bike: false, sit: false, jump: 0, wave: false,
    pvp: role === 'teacher' ? true : !!m.pvp,   // 老师必须可被学生攻击
    weapon: 'sword',
    sleep: !!m.sleep,
    maxHp: MAX_STUDENT_HP,
    hp: MAX_STUDENT_HP,
    bossHp: role === 'teacher' ? MAX_BOSS_HP : 0,
    dead: false,
    bossDead: false,
    phase: 1,
    skillCd: { smash: 0, bolt: 0, burst: 0, quake: 0 },
    atkCd: 0,
    lastMove: 0,
    lastChat: 0,
    joinedAt: now(),
  };

  players.set(p.id, p);
  ws.__pid = p.id;
  if (cid) cidIndex.set(cid, p.id);

  send(p, {
    t: 'welcome',
    id: p.id,
    n: zoneCount(zone),
    all: onlineCount(),
    players: rosterIn(zone, p.id),
    bosses: bossesIn(zone),
    role: p.role,
    hp: p.hp,
    maxHp: p.maxHp,
    score: scores.get(name) || 0,
    pvp: p.pvp,
    zone,
    x: Math.round(p.x),
    y: Math.round(p.y),
    weapon: p.weapon,
    admin: p.admin,
    motd: '欢迎回到郑中',
  });

  broadcastZone(zone, { t: 'join', p: publicOf(p) }, p.id);
  broadcastAll({ t: 'online', n: onlineCount(), all: onlineCount(), players: rosterIn(zone, p.id) });
  broadcastZone(zone, { t: 'bs', list: bossesIn(zone) });
  console.log(`[join] ${name} (${role}) -> ${zone} · 在线 ${onlineCount()}`);
}

function handleMove(p, m) {
  const t0 = now();
  if (t0 - p.lastMove < MOVE_GAP) return;
  p.lastMove = t0;

  const z = zoneOf(p);
  const warp = !!m.warp;
  const nx = num(m.x, p.x, 0, z.w);
  const ny = num(m.y, p.y, 0, z.h);
  if (!warp && (Math.abs(nx - p.x) > 90 || Math.abs(ny - p.y) > 90)) return;

  p.x = nx;
  p.y = ny;
  p.dir = num(m.dir, p.dir, 0, 3) | 0;
  p.anim = String(m.anim || 'idle').slice(0, 12);
  p.run = !!m.run;
  p.bike = !!m.bike;
  p.sit = !!m.sit;
  p.wave = !!m.wave;
  p.jump = num(m.jump, 0, 0, 20);
  p.sleep = !!m.sleep;

  if (p.role === 'teacher') {
    // 老师只通过 bs 同步，其他人不会把他当普通玩家
    broadcastZone(p.zone, { t: 'bs', list: bossesIn(p.zone) }, p.id);
  } else {
    broadcastZone(p.zone, { t: 'm', p: publicOf(p) }, p.id);
  }
}

function handleMessage(ws, raw) {
  if (typeof raw !== 'string' || raw.length > 4096) return;
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  if (!m || typeof m !== 'object') return;

  const p = players.get(ws.__pid);
  if (!p) {
    if (m.t === 'join') handleJoin(ws, m);
    return;
  }
  if (m.t === 'join') {
    // 重复 join：先清掉旧身份，避免一人占两条
    players.delete(p.id);
    if (p.cid && cidIndex.get(p.cid) === p.id) cidIndex.delete(p.cid);
    handleJoin(ws, m);
    return;
  }

  const t0 = now();

  switch (m.t) {
    case 'm':
      handleMove(p, m);
      break;

    case 'c': {
      if (t0 - p.lastChat < 700) return;
      const text = cleanText(m.text, MAX_CHAT);
      if (!text) return;
      p.lastChat = t0;
      p.chat = text;
      broadcastZone(p.zone, { t: 'c', id: p.id, name: p.name, text, ts: t0 });
      break;
    }

    case 'p':
      send(p, { t: 'roster', n: zoneCount(p.zone), players: rosterIn(p.zone, p.id) });
      break;

    case 'attack':
      attack(p, m);
      break;

    case 'tskill':
      castSkill(p, String(m.k || ''));
      break;

    case 'pvp': {
      p.pvp = !!m.on;
      send(p, { t: 'pvpack', on: p.pvp });
      break;
    }

    case 'weapon': {
      p.weapon = m.k === 'bow' ? 'bow' : 'sword';
      send(p, { t: 'weapon', k: p.weapon });
      break;
    }

    case 'enterZone':
      joinZone(p, String(m.zone || 'lobby'));
      break;

    case 'rank': {
      const list = rankList();
      send(p, {
        t: 'rank',
        list: list.slice(0, 50),
        total: list.length,
        zoneName: ZONES[p.zone].name,
      });
      break;
    }

    case 'who': {
      const q = players.get(String(m.id || ''));
      if (q) send(p, { t: 'who', p: publicOf(q) });
      break;
    }

    case 'rename': {
      const name = cleanText(m.name, MAX_NAME);
      if (!name) return;
      p.name = name;
      p.admin = admins.has(name);
      send(p, { t: 'you', name, score: scores.get(name) || 0, admin: p.admin });
      broadcastZone(p.zone, { t: 'bs', list: bossesIn(p.zone) });
      break;
    }

    /* ---------- 管理端 ---------- */
    case 'ann': {
      if (!p.admin) return;
      const text = cleanText(m.text, 120);
      if (!text) return;
      broadcastAll({ t: 'ann', name: p.name, text });
      break;
    }
    case 'notice': {
      if (!p.admin) return;
      const text = cleanText(m.text, 120);
      broadcastAll({ t: 'notice', text, by: p.name, ts: t0 });
      break;
    }
    case 'bell': {
      if (!p.admin) return;
      broadcastAll({ t: 'bell', by: p.name, auto: 0 });
      break;
    }

    case 'bye':
      try { ws.close(1000, 'bye'); } catch { /* ignore */ }
      break;

    default:
      break;
  }
}

function handleClose(ws) {
  const p = players.get(ws.__pid);
  if (!p) return;
  try { delete ws.__pid; } catch { /* ignore */ }
  players.delete(p.id);
  if (p.cid && cidIndex.get(p.cid) === p.id) cidIndex.delete(p.cid);
  broadcastZone(p.zone, { t: 'leave', id: p.id, name: p.name });
  broadcastAll({ t: 'online', n: onlineCount(), all: onlineCount() });
  console.log(`[leave] ${p.name} · 在线 ${onlineCount()}`);
}

/* ============================== HTTP ============================== */

const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX = path.join(PUBLIC_DIR, 'index.html');

/* 静态资源：只放行 public 目录下白名单扩展名，拒绝目录穿越 */
const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
};

/* 压缩缓存：文本资源 gzip 一次，按 mtime 失效 */
const gzCache = new Map();
function gzBuffer(full, st) {
  const key = full + '|' + st.mtimeMs + '|' + st.size;
  let buf = gzCache.get(key);
  if (!buf) {
    try {
      buf = zlib.gzipSync(fs.readFileSync(full), { level: 6 });
    } catch {
      return null;
    }
    if (gzCache.size > 60) gzCache.clear();
    gzCache.set(key, buf);
  }
  return buf;
}

const TEXT_EXT = new Set(['.html', '.css', '.js', '.json', '.svg', '.txt']);

/* 统一响应：按需 gzip + ETag，命中缓存返回 304 */
function sendAsset(req, res, full, st, type, cacheControl) {
  const etag = 'W/"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
  const headers = {
    'content-type': type,
    'cache-control': cacheControl,
    'last-modified': st.mtime.toUTCString(),
    etag,
    vary: 'accept-encoding',
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  const ext = path.extname(full).toLowerCase();
  const canGz = TEXT_EXT.has(ext) && st.size > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  if (canGz) {
    const buf = gzBuffer(full, st);
    if (buf) {
      headers['content-encoding'] = 'gzip';
      headers['content-length'] = buf.length;
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : buf);
      return;
    }
  }
  headers['content-length'] = st.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(full).pipe(res);
}

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (rel.includes('\0')) return false;

  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) return false;

  const ext = path.extname(full).toLowerCase();
  const type = MIME[ext];
  if (!type) return false;

  let st;
  try {
    st = fs.statSync(full);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;

  // 小文件（图标、音频）缓存一天；图片同理；文本资源日更也无妨
  const cc = ext === '.json' ? 'no-cache' : 'public, max-age=86400';
  sendAsset(req, res, full, st, type, cc);
  return true;
}

function healthJson() {
  const list = rankList();
  return {
    ok: true,
    service: '像素校园 · 河北郑口中学',
    mode: 'multiplayer',
    online: onlineCount(),
    zones: Object.entries(ZONES).map(([key, z]) => ({
      key, name: z.name, online: zoneCount(key),
    })),
    guests: 0,
    names: [...players.values()].filter((p) => p.joined).map((p) => p.name),
    maintaining,
    ranking: list.slice(0, 5),
    ts: now(),
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');

  if (url.pathname === '/api/health') {
    const body = JSON.stringify(healthJson());
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    res.end(body);
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const st = fs.statSync(INDEX);
      sendAsset(req, res, INDEX, st, 'text/html; charset=utf-8', 'no-cache');
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('index.html 读取失败: ' + e.message);
    }
    return;
  }

  // 图标别名：部分浏览器/系统会直接找这两个路径
  if (url.pathname === '/apple-touch-icon-precomposed.png') {
    const p2 = path.join(PUBLIC_DIR, 'apple-touch-icon.png');
    try {
      const st2 = fs.statSync(p2);
      sendAsset(req, res, p2, st2, 'image/png', 'public, max-age=86400');
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    }
    return;
  }

  if (serveStatic(req, res, url.pathname)) return;

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname !== '/ws' && url.pathname !== '/ws/') {
    socket.destroy();
    return;
  }
  if (maintaining) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => {
    try { handleMessage(ws, typeof data === 'string' ? data : data.toString()); }
    catch (e) { console.error('[msg]', e.message); }
  });
  ws.on('close', () => handleClose(ws));
  ws.on('error', () => { try { ws.close(); } catch { /* ignore */ } });
});

// 心跳：清掉半死连接
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch { /* ignore */ } continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 30000);

setInterval(announceOnline, 15000);

/* ============================== 启动 ============================== */

loadScores();

server.listen(PORT, HOST, () => {
  console.log(`像素校园服务端已启动 http://${HOST}:${PORT}`);
  console.log(`  /ws         WebSocket 联机
  /api/health 健康检查
  /           游戏页面`);
});

process.on('SIGTERM', () => { try { saveScoresSoon(); } catch { /* ignore */ } process.exit(0); });
