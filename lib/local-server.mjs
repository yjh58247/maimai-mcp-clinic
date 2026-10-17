import { once } from 'node:events';

export async function listenLocal(server, firstPort, attempts = 10) {
  for (let port = firstPort; port <= Math.min(65535, firstPort + attempts - 1); port++) {
    try {
      const listening = once(server, 'listening');
      server.listen(port, '127.0.0.1');
      await listening;
      return server.address().port;
    } catch (error) {
      if (error.code !== 'EADDRINUSE' || port === Math.min(65535, firstPort + attempts - 1)) throw error;
    }
  }
  throw new Error('没有可用的本机端口。');
}
