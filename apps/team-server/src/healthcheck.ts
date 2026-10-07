/**
 * The image's HEALTHCHECK (no shell in a distroless image): ask this container's own server for
 * `/v1/health`. It is this machine, so the certificate is not checked here.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const port = Number(process.env.AIO_PORT ?? 8443);
const secure = Boolean(process.env.AIO_TLS_CERT_FILE);
const req = (secure ? httpsRequest : httpRequest)(
  {
    host: '127.0.0.1',
    port,
    path: '/v1/health',
    timeout: 4000,
    ...(secure ? { rejectUnauthorized: false } : {}),
  },
  (res) => {
    res.resume();
    process.exitCode = res.statusCode === 200 ? 0 : 1;
  },
);
req.on('timeout', () => req.destroy(new Error('timeout')));
req.on('error', () => {
  process.exitCode = 1;
});
req.end();
