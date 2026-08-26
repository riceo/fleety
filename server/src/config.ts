import path from 'node:path';

const env = process.env;

export const config = {
  port: Number(env.PORT || 8080),
  host: env.HOST || '0.0.0.0',
  dataDir: path.resolve(env.DATA_DIR || './data'),
  adminUser: env.ADMIN_USER || '',
  adminPassword: env.ADMIN_PASSWORD || '',
  production: env.NODE_ENV === 'production',
  // Cookies are marked Secure in production (behind Caddy TLS).
  secureCookies: env.COOKIE_SECURE ? env.COOKIE_SECURE === '1' : env.NODE_ENV === 'production',
  userAgent: 'InvictaFleetView/1.0 (club fleet tracker; contact via invictaaero.club)',
};

export const dbPath = () => path.join(config.dataDir, 'db', 'fleetview.db');
export const uploadsDir = () => path.join(config.dataDir, 'uploads');
export const backupsDir = () => path.join(config.dataDir, 'backups');
