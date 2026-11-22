/**
 * 像素校园 · 河北郑口中学 —— Cloudflare Workers 版游戏世界
 *
 * 由 server.js 移植：逻辑、协议、数值完全一致，差异只在运行时
 *  - HTTP 静态资源由 Workers Static Assets 提供（见 worker.js）
 *  - WebSocket 由单个 Durable Object 承载（一个实例 = 一个世界）
 *  - 排行榜落在 DO KV 存储里，不再依赖容器本地文件
 */

/** ws -> playerId（Workers 的 WebSocket 是宿主对象，不能挂自定义属性） */
const WS_OWNER = new WeakMap();

/* ============================== 常量 ============================== */

const ZONES = {
  lobby: { w: 1024, h: 1000, spawn: { x: 512, y: 520 }, name: '大厅' },
  exp: { w: 2304, h: 1898, spawn: { x: 120, y: 1338 }, name: 'A 区（卫星版）' },
  gen: { w: 2304, h: 1216, spawn: { x: 120, y: 760 }, name: 'B 区（像素版）' },
  // 星露谷风：用同一张卫星图的像素重绘版做底图，碰撞沿用 A 区（卫星版）
  stardew: { w: 2304, h: 1898, spawn: { x: 120, y: 1338 }, name: '星露谷风' },
};

const MAX_STUDENT_HP = 100;
const MAX_BOSS_HP = 1000;
const REVIVE_MS = 5000;
const SLEEP_HEAL_PER_SEC = 6;   // 睡觉每秒回血（100 血约 17 秒睡满）

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
const MOVE_GAP = 20;            // 单连接收包最小间隔（防刷包）
const NET_TICK_MS = 50;         // 20Hz 固定快照节拍：所有玩家同一时刻采样、合并成一包
let CD_SCALE = 1;               // 压测用，生产保持 1（由 env 注入）


/* ============================== 工具 ============================== */

const now = () => Date.now();
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v, fb, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) ? clamp(n, lo, hi) : fb;
};
const cleanText = (v, max) =>
  String(v ?? '').replace(/[\r\n\t<>]/g, '').trim().slice(0, max);
const rid = () => 'p' + now().toString(36) + Math.random().toString(16).slice(2, 8);

/* ============================== 排行榜持久化 ============================== */

let scores = new Map();          // name -> score

/* 管理员暗号（与前端 ADMIN_INPUTS 完全一致）：
   输入 userMJY → 显示 MJY 并具备管理员权限；输入 userYNY → YNY。
   单写 MJY / YNY 只是普通昵称，不给权限。 */
const ADMIN_INPUTS = { usermjy: 'MJY', useryny: 'YNY' };
function normName(raw) {
  const base = cleanText(raw, MAX_NAME) || '同学';
  const hit = ADMIN_INPUTS[base.toLowerCase()];
  if (hit) return { name: hit, admin: true };
  return { name: base, admin: false };
}

let admins = new Set();

/** 排行榜持久化：存在 Durable Object 的 KV 存储里，容器重启/迁移都不丢 */
let STORAGE = null;
async function loadScores() {
  if (!STORAGE) return;
  try {
    const raw = await STORAGE.get('scores');
    if (!raw) return;
    for (const [k, v] of Object.entries(raw.scores || {})) scores.set(k, Number(v) || 0);
    for (const n of raw.admins || []) admins.add(n);
  } catch { /* 首次运行没有数据 */ }
}
let saveTimer = null;
function saveScoresSoon() {
  if (saveTimer || !STORAGE) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      STORAGE.put('scores', {
        scores: Object.fromEntries(scores),
        admins: [...admins],
      });
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

let maintaining = false;

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
    st: Math.round(p.st || 0),
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

/* ---------- 20Hz 快照广播 ----------
   之前是「谁动一下就给全区分发一条」，包到达时刻完全随机：
   客户端每隔几十毫秒收到一条不同玩家的位置突变，只能靠"追赶"去贴，
   于是形成 20Hz 的速度脉冲（一鼓一鼓）。
   现在改成固定 50ms 一次：同一分区所有玩家在同一时刻采样、压成一个数组、
   只序列化一次、一条包发出。客户端拿到的时间戳等间隔，才能做匀速插值。 */

const ANIM_IDX = { idle: 0, run: 1, walk: 2 };

/** 一条采样：[id,x,y,dir,anim,flags,jump,hp,t]
 *  末尾 t 是这条坐标"产生"的时刻（服务器时钟），不是发包时刻。
 *  这样客户端插值看到的是等间隔、匀速的真实轨迹，不会因为采样相位差产生拍频。 */
function packSample(s) {
  const f = (s.run ? 1 : 0) | (s.bike ? 2 : 0) | (s.sit ? 4 : 0) |
            (s.wave ? 8 : 0) | (s.sleep ? 16 : 0) | (s.dead ? 32 : 0) |
            (s.pvp ? 0 : 64);
  return [
    s.id,
    Math.round(s.x * 10) / 10,
    Math.round(s.y * 10) / 10,
    s.dir | 0,
    ANIM_IDX[s.anim] ?? 0,
    f,
    Math.round(s.jump || 0),
    Math.round(s.hp ?? 0),
    Math.round(s.t),
  ];
}

function netTick() {
  const t = now();
  /** @type {Map<string, {a:any[], boss:boolean}>} */
  const byZone = new Map();

  for (const p of players.values()) {
    if (!p.joined) continue;
    let z = byZone.get(p.zone);
    if (!z) { z = { a: [], boss: false }; byZone.set(p.zone, z); }
    if (p.role === 'teacher') { z.boss = true; p.sq.length = 0; continue; }
    for (const s of p.sq) z.a.push(packSample(s));
    p.sq.length = 0;
  }

  for (const [zone, z] of byZone) {
    if (z.a.length) broadcastZone(zone, { t: 'mm', s: t, a: z.a });
    // 老师（Boss）仍走 bs：带技能冷却、施法状态
    if (z.boss) broadcastZone(zone, { t: 'bs', list: bossesIn(zone) });
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
  // 兜底：目标关闭攻击系统则完全免疫（findTargets 已过滤，这里防新增路径漏判）
  if (!target.pvp) return false;
  // 兜底：攻击方关闭攻击系统则打不出伤害
  if (by && by.id !== target.id && !by.pvp) return false;

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
    send(target, { t: 'you', name: target.name, score: scores.get(target.name) || 0, admin: !!target.admin });
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
  // 关闭攻击系统后，Boss 的技能也不能生效
  if (!p.pvp) {
    send(p, { t: 'bmsg', ok: 0, msg: '攻击系统已关闭，先开启才能使用技能' });
    return;
  }
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
  const nm = normName(m.name);
  const name = nm.name;
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
    admin: nm.admin || admins.has(name),
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
    st: 0, lastSt: 0, clkOff: null, sq: [],   // 移动采样队列与时钟校准
    joinedAt: now(),
  };

  players.set(p.id, p);
  WS_OWNER.set(ws, p.id);
  if (cid) cidIndex.set(cid, p.id);

  send(p, {
    t: 'welcome',
    id: p.id,
    s: now(),              // 服务器时钟：客户端用它校准插值时间轴
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
  const warp = !!m.warp;
  /* warp=true 是客户端的状态变更包（停下、跳跃、坐下、睡觉…），一定要收，
     否则停下那一刻的包被节流丢掉，别人会一直看到你在原地走。 */
  if (!warp && t0 - p.lastMove < MOVE_GAP) return;
  p.lastMove = t0;

  const z = zoneOf(p);
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

  /* 这条坐标的产生时刻（服务器时钟）。
     客户端带上自己发送时的本地时间，服务端用「最小单程延迟」估计时钟差，
     把网络抖动从时间轴上剔除 —— 否则同一 20Hz 的采样会和 20Hz 的广播节拍
     产生拍频：某一帧重复上一条坐标（画面停一拍），下一帧又补两格（跳一下）。 */
  const cts = num(m.ts, 0, 0, 1e15);
  let st;
  if (cts > 0) {
    const off = t0 - cts;
    if (p.clkOff == null || off > p.clkOff) p.clkOff = off;   // 最小延迟样本
    else p.clkOff += (off - p.clkOff) * 0.002;                // 极慢跟随时钟漂移
    st = cts + p.clkOff;
  } else {
    st = t0;
  }
  if (!(st > p.lastSt)) st = p.lastSt + 1;   // 严格递增
  p.lastSt = st;
  p.st = st;

  p.sq.push({
    id: p.id, t: st, x: p.x, y: p.y, dir: p.dir, anim: p.anim,
    run: p.run, bike: p.bike, sit: p.sit, wave: p.wave, sleep: p.sleep,
    dead: p.dead, pvp: p.pvp, jump: p.jump, hp: p.hp,
  });
  if (p.sq.length > 4) p.sq.splice(0, p.sq.length - 4);   // 突发补包时只保留最近几条
}

function handleMessage(ws, raw) {
  if (typeof raw !== 'string' || raw.length > 4096) return;
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  if (!m || typeof m !== 'object') return;

  const p = players.get(WS_OWNER.get(ws));
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
      const nm = normName(m.name);
      if (!nm.name) return;
      const oldName = p.name;
      p.name = nm.name;
      p.admin = nm.admin || admins.has(nm.name);
      if (oldName !== p.name) {
        // 名牌、聊天里的名字都要换掉
        broadcastZone(p.zone, { t: 'leave', id: p.id, name: oldName });
        broadcastZone(p.zone, { t: 'join', p: publicOf(p) }, p.id);
      }
      send(p, { t: 'you', name: p.name, score: scores.get(p.name) || 0, admin: p.admin });
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
  const p = players.get(WS_OWNER.get(ws));
  WS_OWNER.delete(ws);
  if (!p) return;
  players.delete(p.id);
  if (p.cid && cidIndex.get(p.cid) === p.id) cidIndex.delete(p.cid);
  broadcastZone(p.zone, { t: 'leave', id: p.id, name: p.name });
  broadcastAll({ t: 'online', n: onlineCount(), all: onlineCount() });
  console.log(`[leave] ${p.name} · 在线 ${onlineCount()}`);
}


/* ============================== 周期任务 ============================== */

/** 睡觉回血：每秒结算一次，同区所有人都能看到 +N 飘字 */
function sleepHeal() {
  for (const p of players.values()) {
    if (!p.joined || p.dead || !p.sleep) continue;
    const max = p.role === 'teacher' ? MAX_BOSS_HP : MAX_STUDENT_HP;
    const cur = p.role === 'teacher' ? p.bossHp : p.hp;
    if (cur >= max) continue;
    const next = Math.min(max, cur + SLEEP_HEAL_PER_SEC);
    const amount = next - cur;
    if (amount <= 0) continue;
    if (p.role === 'teacher') p.bossHp = next; else p.hp = next;
    broadcastZone(p.zone, {
      t: 'heal',
      id: p.id,
      hp: next,
      x: Math.round(p.x),
      y: Math.round(p.y),
      amount,
    });
  }
}

/** 心跳：Workers 侧不能发 ping 帧，用应用层空包让死连接尽快暴露 */
function heartbeat() {
  for (const p of players.values()) {
    if (!p.joined || !p.ws) continue;
    try { p.ws.send('{"t":"hb"}'); } catch { /* ignore */ }
  }
}

function healthJson() {
  const list = rankList();
  return {
    ok: true,
    service: '像素校园 · 河北郑口中学',
    mode: 'multiplayer',
    runtime: 'cloudflare-workers',
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

/* ============================== Durable Object ============================== */

/** 一个实例 = 一个游戏世界（与原 Node 单进程语义一致） */
export class Game {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    STORAGE = state.storage;
    CD_SCALE = Number(env.CD_SCALE || 1);
    maintaining = env.MAINTAIN === '1';
    if (env.ADMIN_NAMES) {
      for (const n of String(env.ADMIN_NAMES).split(',')) {
        const s = n.trim();
        if (s) admins.add(s);
      }
    }

    // 新实例 = 新世界：上次退出时残留的连接全部作废
    players.clear();
    cidIndex.clear();

    state.blockConcurrencyWhile(async () => { await loadScores(); });

    // 20Hz 快照节拍（自校正，避免累计漂移）
    let next = Date.now() + NET_TICK_MS;
    const tickLoop = () => {
      try { netTick(); } catch (e) { console.error('[tick]', e.message); }
      next += NET_TICK_MS;
      const d = next - Date.now();
      if (d < -NET_TICK_MS) next = Date.now() + NET_TICK_MS;
      setTimeout(tickLoop, Math.max(1, d));
    };
    setTimeout(tickLoop, NET_TICK_MS);

    setInterval(() => { try { announceOnline(); } catch { /* ignore */ } }, 15000);
    setInterval(() => { try { sleepHeal(); } catch { /* ignore */ } }, 1000);
    setInterval(() => { try { heartbeat(); } catch { /* ignore */ } }, 30000);
  }

  async fetch(request) {
    const upgrade = (request.headers.get('Upgrade') || '').toLowerCase();
    if (upgrade !== 'websocket') {
      return new Response(JSON.stringify(healthJson()), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'access-control-allow-origin': '*',
        },
      });
    }
    if (maintaining) {
      return new Response('maintenance', { status: 503 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    WS_OWNER.set(server, null);

    server.addEventListener('message', (ev) => {
      try {
        const raw = typeof ev.data === 'string' ? ev.data : '';
        handleMessage(server, raw);
      } catch (e) { console.error('[msg]', e && e.message); }
    });
    server.addEventListener('close', () => {
      try { handleClose(server); } catch { /* ignore */ }
    });
    server.addEventListener('error', () => {
      try { server.close(); } catch { /* ignore */ }
    });

    return new Response(null, { status: 101, webSocket: client });
  }
}
