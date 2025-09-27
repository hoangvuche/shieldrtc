import http from 'http';
import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import Redis from 'ioredis';

const JWT_SECRET = process.env.JWT_SECRET || 'change_me';
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

const redis = new Redis(REDIS_PORT, REDIS_HOST);
const pub = new Redis(REDIS_PORT, REDIS_HOST);

// HTTP healthz
const httpServer = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.statusCode = 200;
    res.end('ok');
    return;
  }
  res.statusCode = 404;
  res.end('not found');
});

const wss = new WebSocketServer({ noServer: true });

type ClientState = {
  authed: boolean;
  userId?: string;
  room?: string;
};

function verifySignalJWT(token: string): { sub?: string } {
  const payload = jwt.verify(token, JWT_SECRET) as any;
  return { sub: payload.sub };
}

httpServer.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/signal')) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  const state: ClientState = { authed: false };

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const type = msg.type;
      if (type === 'AUTH') {
        try {
          const { sub } = verifySignalJWT(msg.token);
          state.authed = true;
          state.userId = sub || 'user';
          ws.send(JSON.stringify({ type: 'AUTH_OK' }));
        } catch (e) {
          ws.send(JSON.stringify({ type: 'AUTH_ERR', error: 'invalid token' }));
        }
        return;
      }

      if (!state.authed) {
        ws.send(JSON.stringify({ type: 'ERR', error: 'unauthorized' }));
        return;
      }

      if (type === 'JOIN') {
        const room = String(msg.room || 'demo');
        state.room = room;
        await redis.sadd(`room:${room}:members`, state.userId || 'user');
        ws.send(JSON.stringify({ type: 'JOINED', room }));
        await pub.publish(`room:${room}:events`, JSON.stringify({ type: 'JOIN', user: state.userId }));
        return;
      }

      if (type === 'LEAVE') {
        const room = state.room;
        if (room) {
          await redis.srem(`room:${room}:members`, state.userId || 'user');
          await pub.publish(`room:${room}:events`, JSON.stringify({ type: 'LEAVE', user: state.userId }));
          state.room = undefined;
          ws.send(JSON.stringify({ type: 'LEFT' }));
        }
        return;
      }

      if (type === 'PING') {
        ws.send(JSON.stringify({ type: 'PONG', t: Date.now() }));
        return;
      }

      ws.send(JSON.stringify({ type: 'ERR', error: 'unknown type' }));
    } catch (e) {
      ws.send(JSON.stringify({ type: 'ERR', error: 'bad message' }));
    }
  });

  ws.on('close', async () => {
    if (state.room) {
      await redis.srem(`room:${state.room}:members`, state.userId || 'user');
    }
  });
});

httpServer.listen(8082, () => {
  console.log('HTTP health on :8082, WS on /signal via Nginx');
});
