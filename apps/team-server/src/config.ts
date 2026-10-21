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
  /** The tables' owner, for the migrations (`AIO_MIGRATION_DATABASE_URL`); null: `databaseUrl`. */
  migrationDatabaseUrl: string | null;
  name: string;
  tls: { cert: Buffer; key: Buffer; fingerprint: string } | null;
  behindProxy: boolean;
  /**
   * The reverse proxy addresses (IPs or CIDRs) whose `X-Forwarded-*` headers count; empty when the
   * server is not behind a proxy. Never "any address": that would let anyone pick the address
   * the rate limits see.
   */
  trustedProxies: string[];
  /** Refuse requests that carry a content type or range without signing it. */
  requireSignedHeaders: boolean;
  /** Unfinished blob uploads per device, in bytes. */
  partialQuotaBytes: number;
  publicUrl: string | null;
  fingerprint: string | null;
  log: boolean;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
/** An IPv4 or IPv6 address, optionally with a prefix length. */
const PROXY_ADDRESS = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]*:[0-9a-fA-F:.]*)(?:\/\d{1,3})?$/;

export class ConfigError extends Error {}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dataDir = resolve(env.AIO_DATA_DIR ?? './data');
  const behindProxy = env.AIO_BEHIND_TLS_PROXY === '1';
  // behind a proxy, only the proxy should reach the server: this computer unless told otherwise
  const host = env.AIO_HOST ?? (behindProxy ? '127.0.0.1' : '0.0.0.0');
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
  const trustedProxies = behindProxy
    ? (env.AIO_TRUSTED_PROXIES ?? '127.0.0.1,::1')
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
    : [];
  for (const p of trustedProxies)
    if (!PROXY_ADDRESS.test(p) || p === '0.0.0.0/0' || p === '::/0')
      throw new ConfigError(
        'AIO_TRUSTED_PROXIES lists the reverse proxy addresses (IPs or CIDRs, such as 10.0.0.5 or 172.18.0.0/16), separated by commas.',
      );
  const quotaGb = Number(env.AIO_BLOB_PARTIAL_QUOTA_GB ?? 64);
  if (!Number.isFinite(quotaGb) || quotaGb <= 0)
    throw new ConfigError('AIO_BLOB_PARTIAL_QUOTA_GB is a number of gigabytes.');
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
    migrationDatabaseUrl: env.AIO_MIGRATION_DATABASE_URL ?? null,
    name: env.AIO_SERVER_NAME ?? 'Team server',
    tls,
    behindProxy,
    trustedProxies,
    requireSignedHeaders: env.AIO_REQUIRE_SIGNED_HEADERS === '1',
    partialQuotaBytes: Math.round(quotaGb * 1024 ** 3),
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
