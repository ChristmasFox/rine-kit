import { createServer, type Server } from 'node:http';

export function startWorkerHealthServer(port = 8081): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/healthz') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not_found\n');
      return;
    }
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
    });
    response.end('ok\n');
  });

  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

/** Prometheus-format aggregate metrics for host-local scraping. Compose must
 * publish this listener only on 127.0.0.1; no tenant or actor labels are used. */
export function startWorkerMetricsServer(render: () => string, port = 9464): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/metrics') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not_found\n');
      return;
    }
    let body: string;
    try { body = render(); }
    catch {
      response.writeHead(503, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' });
      response.end('metrics_unavailable\n');
      return;
    }
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
    });
    response.end(body);
  });

  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '0.0.0.0');
  });
}

function stopServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

export function stopWorkerHealthServer(server: Server): Promise<void> {
  return stopServer(server);
}

export function stopWorkerMetricsServer(server: Server): Promise<void> {
  return stopServer(server);
}
