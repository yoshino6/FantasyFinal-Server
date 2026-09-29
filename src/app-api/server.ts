import type { Server } from 'node:http';
import Koa from 'koa';
import koaRouter from 'koa-router';
import { WebSocketServer, WebSocket } from 'ws';
import { logger } from 'alemonjs';
import { getAppApiServerConfig } from '../config/app-api-server';
import { sessionForApp, type AppSession } from '../game/app-channel.service';
import { registerAppApiRoutes } from './router';
import { chatChannelKey, consumeRealtimeTicket, listChatChannels, sendChatMessage, subscribePartyRecruitmentChanges } from './social.service';
import { listWebNotifications } from './notification.service';

type AppApiGlobal = typeof globalThis & {
  __fantasyFinalAppApiServer?: Server;
};

const closePreviousServer = async () => {
  const state = globalThis as AppApiGlobal;
  const previousServer = state.__fantasyFinalAppApiServer;
  if (!previousServer?.listening) return;
  await new Promise<void>((resolve, reject) => {
    previousServer.close(error => (error ? reject(error) : resolve()));
  });
  delete state.__fantasyFinalAppApiServer;
};

export const startAppApiServer = async () => {
  const config = getAppApiServerConfig();
  if (!config.enabled) return;

  await closePreviousServer();

  const app = new Koa();
  app.use(async (ctx, next) => {
    ctx.set('Access-Control-Allow-Origin', '*');
    ctx.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    ctx.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    if (ctx.method === 'OPTIONS') {
      ctx.status = 204;
      return;
    }
    await next();
  });
  const router = new koaRouter();
  registerAppApiRoutes(router);
  registerAppApiRoutes(router, '/api/desktop/v1');
  registerAppApiRoutes(router, '/api/web/v1');
  app.use(router.routes());
  app.use(router.allowedMethods());

  const server = app.listen(config.port, config.listenHost);
  await new Promise<void>((resolve, reject) => {
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    server.once('listening', onListening);
    server.once('error', onError);
  });

  // 浏览器聊天使用一次性 ticket 建立短连接；历史和权限仍由 REST 接口负责。
  const realtime = new WebSocketServer({ noServer: true });
  type Client = { socket: WebSocket; token: string; session: AppSession; channelId?: string; channelKey?: string };
  const clients = new Set<Client>();
  const send = (socket: WebSocket, value: unknown) => {
    if (socket.readyState === WebSocket.OPEN) {
      try { socket.send(JSON.stringify(value)); } catch { try { socket.close(); } catch { /* 连接已断开。 */ } }
    }
  };
  const refreshClient = async (client: Client): Promise<AppSession | null> => {
    const current = await sessionForApp(client.token);
    if (!current || current.playerId !== client.session.playerId) {
      client.channelId = undefined;
      client.channelKey = undefined;
      send(client.socket, { type: 'error', message: '登录已失效，请重新登录。' });
      client.socket.close(1008, 'Session expired');
      return null;
    }
    client.session = current;
    return current;
  };
  const unsubscribeRecruitmentChanges = subscribePartyRecruitmentChanges(event => {
    for (const client of clients) if (client.channelId === event.channelId) {
      void refreshClient(client).then(current => {
        if (current && client.channelId === event.channelId) send(client.socket, { type: 'channel-updated', ...event });
      }).catch(error => logger.warn({ err: error }, '组队频道实时提示失败'));
    }
  });
  server.once('close', unsubscribeRecruitmentChanges);
  server.on('upgrade', (request, socket, head) => {
    let url: URL;
    try { url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`); }
    catch { socket.destroy(); return; }
    if (url.pathname !== '/api/web/v1/realtime') { socket.destroy(); return; }
    const auth = consumeRealtimeTicket(url.searchParams.get('ticket'));
    if (!auth) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    void sessionForApp(auth.token).then(current => {
      if (!current || current.playerId !== auth.session.playerId) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
      }
      if (!socket.destroyed) realtime.handleUpgrade(request, socket, head, client => realtime.emit('connection', client, { ...auth, session: current }));
    }).catch(error => {
      logger.warn({ err: error }, '实时连接身份校验失败');
      socket.destroy();
    });
  });
  realtime.on('connection', (socket: WebSocket, auth: { session: AppSession; token: string }) => {
    const client: Client = { socket, ...auth };
    clients.add(client);
    void listChatChannels(client.session).then(channels => send(socket, { type: 'ready', channels })).catch(error => send(socket, { type: 'error', message: error instanceof Error ? error.message : '实时连接初始化失败。' }));
    let lastNotificationState: { latestId: number; unreadCount: number } | undefined;
    let notificationCheckRunning = false;
    // WebSocket 只推轻量变化提示；完整内容由有游标的 REST 接口补拉。
    const checkNotifications = async () => {
      if (notificationCheckRunning || socket.readyState !== WebSocket.OPEN) return;
      notificationCheckRunning = true;
      try {
        const current = await refreshClient(client);
        if (!current) return;
        const page = await listWebNotifications(current.playerId, { limit: 1 });
        const latestId = page.items[0]?.id ?? 0;
        if (!lastNotificationState || lastNotificationState.latestId !== latestId || lastNotificationState.unreadCount !== page.unreadCount) {
          lastNotificationState = { latestId, unreadCount: page.unreadCount };
          send(socket, { type: 'notification', latestId, unreadCount: page.unreadCount });
        }
      } catch (error) {
        logger.warn({ err: error }, 'Web 通知检查失败');
      } finally {
        notificationCheckRunning = false;
      }
    };
    void checkNotifications();
    const notificationTimer = setInterval(() => { void checkNotifications(); }, 15_000);
    socket.on('message', data => {
      void (async () => {
        try {
          const current = await refreshClient(client);
          if (!current) return;
          let message: unknown;
          try { message = JSON.parse(String(data)); } catch { send(socket, { type: 'error', message: '实时消息格式无效。' }); return; }
          if (!message || typeof message !== 'object' || Array.isArray(message)) { send(socket, { type: 'error', message: '实时消息格式无效。' }); return; }
          const input = message as Record<string, unknown>;
          const channelId = typeof input.channelId === 'string' ? input.channelId.trim() : '';
          if (!channelId || channelId.length > 128) { send(socket, { type: 'error', message: '聊天频道无效。' }); return; }
          if (input.type === 'subscribe') {
            try {
              const channelKey = await chatChannelKey(current, channelId);
              client.channelId = channelId;
              client.channelKey = channelKey;
              send(socket, { type: 'subscribed', channelId });
            } catch (error) { send(socket, { type: 'error', message: error instanceof Error ? error.message : '无法订阅该频道。' }); }
            return;
          }
          if (input.type !== 'message' || client.channelId !== channelId || !client.channelKey) {
            send(socket, { type: 'error', message: '请先订阅聊天频道。' }); return;
          }
          const saved = await sendChatMessage(current, channelId, input.content);
          for (const target of clients) {
            if (target.channelKey !== client.channelKey || !target.channelId) continue;
            try {
              const recipient = target === client ? current : await refreshClient(target);
              if (!recipient) continue;
              const freshKey = await chatChannelKey(recipient, target.channelId);
              if (freshKey !== client.channelKey) throw new Error('频道权限已变化。');
              send(target.socket, { type: 'message', message: { ...saved, channelId: target.channelId, own: target === client } });
            } catch {
              const formerChannelId = target.channelId;
              target.channelId = undefined;
              target.channelKey = undefined;
              send(target.socket, { type: 'unsubscribed', channelId: formerChannelId, message: '频道权限已变化。' });
            }
          }
        } catch (error) {
          send(socket, { type: 'error', message: error instanceof Error ? error.message : '实时消息处理失败。' });
        }
      })();
    });
    socket.on('close', () => { clearInterval(notificationTimer); clients.delete(client); });
    socket.on('error', () => { clearInterval(notificationTimer); clients.delete(client); });
  });

  (globalThis as AppApiGlobal).__fantasyFinalAppApiServer = server;
  logger.info(`桌宠 App 网关已启动：http://${config.listenHost}:${config.port}/api/desktop/v1（兼容 /app-api/v1）`);
};
