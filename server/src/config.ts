import path from 'node:path';

const env = process.env;

export const config = {
  port: Number(env.PORT || 8080),
  host: env.HOST || '0.0.0.0',
  dataDir: path.resolve(env.DATA_DIR || './data'),
  // First-run platform admin (only seeded while the users table is empty).
  adminEmail: env.ADMIN_EMAIL || (env.ADMIN_USER?.includes('@') ? env.ADMIN_USER : ''),
  adminUser: env.ADMIN_USER || 'admin',
  adminPassword: env.ADMIN_PASSWORD || '',
  production: env.NODE_ENV === 'production',
  secureCookies: env.COOKIE_SECURE ? env.COOKIE_SECURE === '1' : env.NODE_ENV === 'production',
  // Tenancy: clubs live on <slug>.<baseDomain>; anything else falls back to
  // defaultClubSlug (handy for localhost QA) or the platform landing page.
  baseDomain: env.BASE_DOMAIN || 'fleety.live',
  defaultClubSlug: env.DEFAULT_CLUB || 'invicta',
  // ADSBexchange rescue tier (optional): probed ONLY for aircraft whose open
  // flight vanished from both free networks, under a hard monthly budget.
  adsbxApiKey: env.ADSBX_API_KEY || '',
  adsbxMonthlyBudget: Number(env.ADSBX_MONTHLY_BUDGET || 9000),
  // Resend (optional): invites/resets are emailed when configured, otherwise
  // the admin gets a shareable link instead.
  resendApiKey: env.RESEND_API_KEY || '',
  emailFrom: env.EMAIL_FROM || 'Fleety <ops@fleety.live>',
  // Operator ping for new waitlist signups.
  waitlistNotifyEmail: env.WAITLIST_NOTIFY_EMAIL || 'cube@sneakybox.com',
  publicBaseUrl: env.PUBLIC_BASE_URL || '', // e.g. https://invicta.fleety.live (per-club links derive from club slug)
  userAgent: 'Fleety/1.0 (club fleet tracker; https://fleety.live)',
};

export const dbPath = () => path.join(config.dataDir, 'db', 'fleetview.db');
export const uploadsDir = () => path.join(config.dataDir, 'uploads');
export const backupsDir = () => path.join(config.dataDir, 'backups');

// Absolute URL for a club's board, used in emails and admin-facing links.
export function clubUrl(slug: string): string {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  return config.production ? `https://${slug}.${config.baseDomain}` : `http://localhost:${config.port}`;
}
