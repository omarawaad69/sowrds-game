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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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

    return new Response(
      'سيرفر ملتيبلاير سيف الأساطير شغال ✅ — استخدم /queue للمطابقة أو /room/{id} للاتصال بغرفة.',
      { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } }
    );
  },
};
