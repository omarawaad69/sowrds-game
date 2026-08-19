/**
 * سيف الأساطير — سيرفر الملتيبلاير (5×5 اونلاين)
 * ============================================================
 * ده Cloudflare Worker باستخدام Durable Objects، وله وظيفتان بسيطتان:
 *
 * 1) Lobby (غرفة انتظار واحدة عامة): كل لاعب بيدخلها وهو بيدور على معركة،
 *    وأول ما يتجمع عدد كافٍ (من 2 لحد 10 لاعبين) بتقسمهم لفريقين وتبعتلهم
 *    "matched" فيها رقم الغرفة (roomId) ومين الـ host.
 *
 * 2) MatchRoom (غرفة لكل معركة): مجرد "مرحّل" (relay) — بتستقبل أي رسالة
 *    JSON من أي لاعب وتبعتها لباقي اللاعبين في نفس الغرفة زي ما هي، من
 *    غير ما تفهم أو تلمس محتوى اللعبة نفسه. كل منطق اللعبة (الحركة،
 *    القتال، الاستيلاء على المناطق) شغال بالفعل جوه index.html على جهاز
 *    الـ "host" (أول لاعب دخل الغرفة)، والباقي بس بيبعتوا حركتهم ويستقبلوا
 *    حالة اللعبة الجاهزة. ده بيخلي السيرفر بسيط جداً وسهل الصيانة.
 *
 * ⚠️ ملاحظات مهمة:
 * - Durable Objects محتاجة خطة Cloudflare Workers المدفوعة (Paid) —
 *   مش متاحة على الخطة المجانية بالكامل وقت كتابة الكود ده.
 * - النموذج ده "host-relay": الـ host بيشغّل المحاكاة فعلياً، فلو غش
 *   حد بيشغل هوست معدَّل يقدر يأثر على نتيجة معركته هو بس (مش بيانات
 *   حسابات لاعبين تانيين المحفوظة أصلاً على أجهزتهم). كفاية تماماً
 *   للعبة تسلية زي دي.
 * ============================================================
 */

export class Lobby {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.queue = []; // { id, ws, name, cls, joinedAt }
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return new Response('يتوقع اتصال WebSocket', { status: 400 });
    }

    const url = new URL(request.url);
    const id = url.searchParams.get('id') || crypto.randomUUID();
    const name = (url.searchParams.get('name') || 'لاعب').slice(0, 24);
    const cls = url.searchParams.get('cls') || 'warrior';

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    // امنع نفس اللاعب من التسجيل مرتين لو اتصل تاني بسرعة
    this.queue = this.queue.filter((e) => e.id !== id);

    const entry = { id, ws: server, name, cls, joinedAt: Date.now() };
    this.queue.push(entry);

    server.addEventListener('close', () => {
      this.queue = this.queue.filter((e) => e.id !== id);
    });
    server.addEventListener('error', () => {
      this.queue = this.queue.filter((e) => e.id !== id);
    });

    this.tryMatch();

    return new Response(null, { status: 101, webSocket: client });
  }

  // كل ما لاعب يدخل بنحاول نكوّن معركة. أقل عدد لبدء معركة حقيقية هو
  // لاعبين (2)؛ لو اتجمع لغاية 10 هيتم توزيعهم بالتبادل على الفريقين.
  tryMatch() {
    const MIN_PLAYERS = 2;
    const MAX_PLAYERS = 10;
    if (this.queue.length < MIN_PLAYERS) return;

    const group = this.queue.splice(0, Math.min(MAX_PLAYERS, this.queue.length));
    const roomId = crypto.randomUUID();
    const hostId = group[0].id;
    const roster = group.map((e, i) => ({
      id: e.id,
      name: e.name,
      cls: e.cls,
      team: i % 2 === 0 ? 'blue' : 'red',
    }));

    group.forEach((e) => {
      try {
        e.ws.send(JSON.stringify({ type: 'matched', roomId, you: e.id, hostId, roster }));
        e.ws.close(1000, 'matched');
      } catch (err) {
        // اللاعب ده قفل الاتصال قبل ما نوصله الرسالة — تجاهله
      }
    });
  }
}

export class MatchRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Map(); // playerId -> WebSocket
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return new Response('يتوقع اتصال WebSocket', { status: 400 });
    }

    const url = new URL(request.url);
    const playerId = url.searchParams.get('id') || crypto.randomUUID();

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    this.sockets.set(playerId, server);

    // let everyone already in the room know a new peer just joined —
    // used by the 1×1 duel flow so the challenger (who connects and waits
    // first) knows the instant their friend accepts and connects too.
    for (const [pid, sock] of this.sockets) {
      if (pid === playerId) continue;
      try { sock.send(JSON.stringify({ type: 'peer-joined', id: playerId })); } catch (err) {}
    }

    server.addEventListener('message', (evt) => {
      let payload;
      try {
        payload = JSON.parse(evt.data);
      } catch (err) {
        return; // رسالة مش JSON صالحة — اتجاهلها
      }
      payload.from = playerId;
      const out = JSON.stringify(payload);
      for (const [pid, sock] of this.sockets) {
        if (pid === playerId) continue;
        try {
          sock.send(out);
        } catch (err) {
          // اتصال اللاعب ده وقع — هيتنضف في close
        }
      }
    });

    const onGone = () => {
      this.sockets.delete(playerId);
      for (const [, sock] of this.sockets) {
        try {
          sock.send(JSON.stringify({ type: 'peer-left', id: playerId }));
        } catch (err) {}
      }
    };
    server.addEventListener('close', onGone);
    server.addEventListener('error', onGone);

    return new Response(null, { status: 101, webSocket: client });
  }
}

export class PlayerBox {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const method = request.method;

    if (method === 'GET') {
      const pending = (await this.state.storage.get('pending')) || null;
      // a challenge older than 2 minutes is considered stale/expired —
      // whoever sent it should assume it was missed and can retry.
      if (pending && Date.now() - pending.ts > 120000) {
        await this.state.storage.delete('pending');
        return json({ pending: null });
      }
      return json({ pending });
    }

    if (method === 'POST' && url.pathname.endsWith('/clear')) {
      await this.state.storage.delete('pending');
      return json({ ok: true });
    }

    if (method === 'POST') {
      let body;
      try { body = await request.json(); } catch (err) { return json({ error: 'invalid body' }, 400); }
      const challenge = {
        from: String(body.from || '').slice(0, 40),
        fromName: String(body.fromName || 'لاعب').slice(0, 24),
        fromCls: String(body.fromCls || 'warrior').slice(0, 16),
        matchId: String(body.matchId || '').slice(0, 40),
        ts: Date.now(),
      };
      if (!challenge.from || !challenge.matchId) return json({ error: 'missing fields' }, 400);
      await this.state.storage.put('pending', challenge);
      return json({ ok: true });
    }

    return json({ error: 'method not allowed' }, 405);
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,OPTIONS',
          'access-control-allow-headers': 'content-type',
        },
      });
    }

    if (url.pathname === '/queue') {
      const id = env.LOBBY.idFromName('global-lobby');
      const stub = env.LOBBY.get(id);
      return stub.fetch(request);
    }

    if (url.pathname.startsWith('/room/')) {
      const roomId = url.pathname.slice('/room/'.length);
      if (!roomId) return new Response('روم آي دي ناقص', { status: 400 });
      const id = env.MATCH.idFromName(roomId);
      const stub = env.MATCH.get(id);
      return stub.fetch(request);
    }

    // friend-challenge mailbox: /box/{friendCode} and /box/{friendCode}/clear
    if (url.pathname.startsWith('/box/')) {
      const code = url.pathname.slice('/box/'.length).split('/')[0];
      if (!code) return json({ error: 'code ناقص' }, 400);
      const id = env.PLAYERBOX.idFromName(code.toUpperCase());
      const stub = env.PLAYERBOX.get(id);
      return stub.fetch(request);
    }

    return new Response(
      'سيرفر ملتيبلاير سيف الأساطير شغال ✅ — استخدم /queue للمطابقة، /room/{id} للاتصال بغرفة، أو /box/{code} لصندوق تحديات الأصدقاء.',
      { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } }
    );
  },
};
