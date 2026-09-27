import { definePlatform } from 'alemonjs';

const main = () => {
  if (typeof process.send === 'function') {
    process.send({ type: 'transport_ready', protocolVersion: 'v2', transport: 'ipc' });
  }
};

export default definePlatform({ name: 'server', main });
