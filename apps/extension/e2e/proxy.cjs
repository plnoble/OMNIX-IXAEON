/**
 * 最小 CONNECT 代理（e2e 专用）：把 chatgpt.com:443 的连接转给本地 https mock，
 * 其它主机一律拒绝（测试浏览器只应访问 chatgpt.com 与 127.0.0.1）。
 */
const http = require('node:http');
const net = require('node:net');

function startConnectProxy(targetPort) {
  const server = http.createServer((req, res) => {
    // 普通 HTTP 请求不应出现（页面是 https）
    res.statusCode = 403;
    res.end('proxy: only CONNECT allowed');
  });
  server.on('connect', (req, clientSocket, head) => {
    const [host] = (req.url ?? '').split(':');
    if (host !== 'chatgpt.com') {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.destroy();
      return;
    }
    // CONNECT 目标端口一律转发到本地 https mock 端口（由 targetPort 指定）
    const upstream = net.connect(targetPort, '127.0.0.1', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => {
      clientSocket.destroy();
    });
    clientSocket.on('error', () => {
      upstream.destroy();
    });
  });
  return new Promise((resolve) => {
    server.listen(8888, '127.0.0.1', () => resolve(server));
  });
}

module.exports = { startConnectProxy };
