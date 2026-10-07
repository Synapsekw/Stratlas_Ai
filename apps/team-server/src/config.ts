/**
 * Server settings from the environment (Docker style). TLS is required outside this computer:
 * either the server ends TLS itself (certificate and key files) or it runs behind a reverse proxy
 * that does (`AIO_BEHIND_TLS_PROXY=1`, with the public address and the certificate fingerprint
 * people see).
 */
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  keyFile: string;
  blobStore: 'fs' | 's3';
  blobDir: string;
  databaseUrl: string | null;
  name: string;
  tls: { cert: Buffer; key: Buffer; fingerprint: string } | null;
  behindProxy: boolean;
  publicUrl: string | null;
  fingerprint: string | null;
  log: boolean;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export class ConfigError extends Error {}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dataDir = resolve(env.AIO_DATA_DIR ?? './data');
  const host = env.AIO_HOST ?? '0.0.0.0';
  const port = Number(env.AIO_PORT ?? 8443);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new ConfigError('AIO_PORT must be a port number.');
  const certFile = env.AIO_TLS_CERT_FILE;
  const keyFile = env.AIO_TLS_KEY_FILE;
  if ((certFile && !keyFile) || (!certFile && keyFile))
    throw new ConfigError('Set both AIO_TLS_CERT_FILE and AIO_TLS_KEY_FILE.');
  let tls: ServerConfig['tls'] = null;
  if (certFile && keyFile) {
    const cert = readFileSync(certFile);
    tls = {
      cert,
      key: readFileSync(keyFile),
      fingerprint: new X509Certificate(cert).fingerprint256.replace(/:/g, '').toLowerCase(),
    };
  }
  const behindProxy = env.AIO_BEHIND_TLS_PROXY === '1';
  const publicUrl = env.AIO_PUBLIC_URL ?? null;
  if (publicUrl && !/^https:\/\/[^/]+\/?$/.test(publicUrl))
    throw new ConfigError(
      'AIO_PUBLIC_URL is the https origin people use, such as https://team.example.com.',
    );
  if (behindProxy && !publicUrl)
    throw new ConfigError('Behind a TLS proxy, set AIO_PUBLIC_URL to the address people use.');
  const fingerprint = env.AIO_TLS_FINGERPRINT?.replace(/:/g, '').toLowerCase() ?? null;
  if (fingerprint !== null && !/^[a-f0-9]{64}$/.test(fingerprint))
    throw new ConfigError('AIO_TLS_FINGERPRINT is the SHA-256 of the certificate (64 hex digits).');
  const blobStore = env.AIO_BLOB_STORE ?? 'fs';
  if (blobStore !== 'fs' && blobStore !== 's3')
    throw new ConfigError('AIO_BLOB_STORE is fs or s3.');
  return {
    host,
    port,
    dataDir,
    keyFile: env.AIO_SERVER_KEY_FILE ?? join(dataDir, 'server-key.pem'),
    blobStore,
    blobDir: env.AIO_BLOB_DIR ?? join(dataDir, 'blobs'),
    databaseUrl: env.DATABASE_URL ?? null,
    name: env.AIO_SERVER_NAME ?? 'Team server',
    tls,
    behindProxy,
    publicUrl: publicUrl?.replace(/\/$/, '') ?? null,
    fingerprint: tls?.fingerprint ?? fingerprint,
    log: env.AIO_LOG !== 'off',
  };
}

/** Before listening: TLS is required unless the server only listens on this computer. */
export function requireTls(config: ServerConfig): void {
  if (!config.tls && !config.behindProxy && !LOOPBACK.has(config.host))
    throw new ConfigError(
      'TLS is required outside this computer. Set AIO_TLS_CERT_FILE and AIO_TLS_KEY_FILE, or AIO_BEHIND_TLS_PROXY=1 behind a reverse proxy that ends TLS.',
    );
}
