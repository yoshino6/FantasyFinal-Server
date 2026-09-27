import { definePlatform } from 'alemonjs';

// 桌宠 App 不依赖外部平台连接；平台子进程只需完成
// transport_ready/app_ready 握手，避免 AlemonJS 误判超时。
const main = () => {
  if (typeof process.send === 'function') {
    process.send({ type: 'transport_ready', protocolVersion: 'v2', transport: 'ipc' });
  }
};

export default definePlatform({ name: 'app', main });
