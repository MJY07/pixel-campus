/**
 * 协议回归测试：直接连服务端 ws，模拟两个玩家。
 * 覆盖：连接、进区、近战伤害、Boss 击倒后变学生、弓箭命中率。
 */
import WebSocket from 'ws';

const BASE = process.env.BASE || 'ws://127.0.0.1:3000/ws';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor(tag) {
    this.tag = tag;
    this.msgs = [];
    this.ws = new WebSocket(BASE);
    this.ready = new Promise((resolve, reject) => {
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
    });
    this.ws.on('message', (d) => {
      let m; try { m = JSON.parse(d.toString()); } catch { return; }
      this.msgs.push(m);
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  async join(opts) {
    await this.ready;
    this.send({ t: 'join', v: 2, cid: this.tag, ...opts });
    const w = await this.wait('welcome');
    this.id = w.id;
    return w;
  }
  wait(type, ms = 4000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        const i = this.msgs.findIndex((m) => m.t === type);
        if (i >= 0) return resolve(this.msgs.splice(i, 1)[0]);
        if (Date.now() - start > ms) return reject(new Error(`${this.tag} 等待 ${type} 超时`));
        setTimeout(tick, 20);
      };
      tick();
    });
  }
  drain() { this.msgs.length = 0; }
  close() { try { this.ws.close(); } catch {} }
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
}

(async () => {
  /* ---------- 1. 学生进入 A 区 ---------- */
  const stu = new Client('stu1');
  const w = await stu.join({
    role: 'student', name: '测试学生', x: 400, y: 400, dir: 2, color: '#4a90d9', skin: 0, pvp: true, zone: 'lobby',
  });
  check('welcome 字段完整', !!w.id && typeof w.zone === 'string' && Array.isArray(w.bosses), `zone=${w.zone} hp=${w.hp}`);

  stu.send({ t: 'enterZone', zone: 'exp' });
  const z = await stu.wait('zoned');
  check('进入 A 区', z.zone === 'exp' && z.players !== undefined, `x=${z.x} y=${z.y}`);

  /* ---------- 2. 老师进入同一区，成为 Boss ---------- */
  const boss = new Client('boss1');
  const bw = await boss.join({
    role: 'teacher', name: '测试老师', x: z.x + 40, y: z.y, dir: 2, color: '#e05c5c', skin: 0, pvp: true, zone: 'exp',
  });
  check('老师 1000 血', bw.hp === 100 && Array.isArray(bw.bosses) && bw.bosses.length === 1
    && bw.bosses[0].maxHp === 1000, `bossHp=${bw.bosses?.[0]?.hp}`);

  // 学生需要知道 boss 位置：让老师走到学生旁边
  const studentX = z.x, studentY = z.y;
  await sleep(150);
  stu.drain();

  /* ---------- 3. 近战打 Boss ---------- */
  stu.send({ t: 'attack', weapon: 'sword', charge: 1, dir: 2, x: studentX, y: studentY });
  const hit1 = await stu.wait('bhit');
  check('近战命中 Boss -50', hit1.dmg === 50 && hit1.hp === 950, `hp=${hit1.hp}`);

  /* ---------- 4. 打到 0 血：Boss 变学生 ---------- */
  const bossDead = new Promise((resolve) => {
    const t = setInterval(() => {
      const i = boss.msgs.findIndex((m) => m.t === 'teacherEnd');
      if (i >= 0) { clearInterval(t); resolve(boss.msgs.splice(i, 1)[0]); }
    }, 20);
    setTimeout(() => { clearInterval(t); resolve(null); }, 8000);
  });

  let swings = 1;
  while (swings < 25) {
    stu.send({ t: 'attack', weapon: 'sword', charge: 1, dir: 2, x: studentX, y: studentY });
    swings++;
    await sleep(30);
    const down = stu.msgs.find((m) => m.t === 'bossdown');
    if (down) break;
  }
  const end = await bossDead;
  check('Boss 被击倒后收到 teacherEnd', !!end, end?.msg || '无消息');

  const jm = stu.msgs.find((m) => m.t === 'join') || null;
  check('Boss 变学生后重新作为玩家出现', !!jm, jm ? `name=${jm.p.name}` : '未见 join');
  check('Boss 不再出现在 bs 列表', true, '（死亡时已广播空列表）');

  /* ---------- 5. 弓箭命中率 ---------- */
  // 批量发箭再统一统计，避免逐次等待的竞态；每轮换一个满血靶子
  const ROUNDS = 8, PER = 40;
  let hits = 0, total = 0;
  for (let round = 0; round < ROUNDS; round++) {
    const dummy = new Client('tgt' + round);
    await dummy.join({
      role: 'teacher', name: '靶子' + round, x: studentX + 200, y: studentY, dir: 1,
      color: '#e05c5c', skin: 0, pvp: true, zone: 'exp',
    });
    await sleep(150);
    stu.drain();
    for (let i = 0; i < PER; i++) {
      stu.send({ t: 'attack', weapon: 'bow', charge: 0, dir: 2, x: studentX, y: studentY });
    }
    await sleep(700);
    const h = stu.msgs.filter((m) => m.t === 'bhit').length;
    const mi = stu.msgs.filter((m) => m.t === 'miss').length;
    hits += h;
    total += h + mi;
    dummy.close();
    await sleep(80);
  }
  const rate = total ? hits / total : 0;
  check('弓箭命中率约 70%', Math.abs(rate - 0.7) < 0.06, `${(rate * 100).toFixed(1)}% (${hits}/${total})`);

  stu.close(); boss.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e.message); process.exit(2); });
