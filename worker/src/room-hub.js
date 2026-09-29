// RoomHub — one Durable Object per room code, relaying the live channel.
//
// Replaces Supabase Realtime (broadcast + presence) for shared/rooms.js's
// RoomConnection. It holds no game state: the move log in D1 stays the source
// of truth, and this is only the low-latency path.
//
// Protocol (JSON text frames):
//   client → hub  { type: 'broadcast', event, payload }   relay to every OTHER socket
//   hub → client  { type: 'broadcast', event, payload }
//   hub → client  { type: 'presence', keys: ['0','1',…] }  on every join/leave
//   'ping' → 'pong' is answered by the runtime without waking the object.
//
// Uses the WebSocket Hibernation API so idle rooms cost nothing.

import { DurableObject } from 'cloudflare:workers';

export class RoomHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/broadcast') && request.method === 'POST') {
      // Server-originated broadcast (from the Worker), delivered to everyone.
      const msg = await request.text();
      for (const ws of this.ctx.getWebSockets()) this.safeSend(ws, msg);
      return new Response('ok');
    }
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      key: String(url.searchParams.get('key') ?? ''),
      name: (url.searchParams.get('name') || '').slice(0, 40),
    });
    this.sendPresence();
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    if (typeof message !== 'string' || message.length > 256 * 1024) return;
    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    if (msg?.type !== 'broadcast' || typeof msg.event !== 'string') return;
    const out = JSON.stringify({ type: 'broadcast', event: msg.event, payload: msg.payload ?? null });
    for (const other of this.ctx.getWebSockets()) {
      if (other !== ws) this.safeSend(other, out);
    }
  }

  webSocketClose(ws, code) {
    try { ws.close(code === 1005 ? 1000 : code, 'closing'); } catch {}
    this.sendPresence(ws);
  }

  webSocketError(ws) {
    this.sendPresence(ws);
  }

  sendPresence(exclude = null) {
    const sockets = this.ctx.getWebSockets().filter((ws) => ws !== exclude);
    const keys = new Set();
    for (const ws of sockets) {
      const a = ws.deserializeAttachment();
      if (a?.key) keys.add(a.key);
    }
    const msg = JSON.stringify({ type: 'presence', keys: [...keys] });
    for (const ws of sockets) this.safeSend(ws, msg);
  }

  safeSend(ws, msg) {
    try { ws.send(msg); } catch {}
  }
}
