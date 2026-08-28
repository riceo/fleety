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
  // How many reverse-proxy hops to trust for X-Forwarded-For (so req.ip — and
  // thus every rate limit — cannot be spoofed via a client-supplied header).
  // A bare number trusts that many hops nearest the app; a comma list is
  // treated as trusted IPs/CIDRs. Default: trust one hop (the immediate proxy,
  // e.g. Caddy/Traefik). Behind Cloudflare→Coolify set TRUST_PROXY=2.
  trustProxy: (() => {
    const v = env.TRUST_PROXY;
    if (v && !/^\d+$/.test(v)) return v.split(',').map((s) => s.trim());
    const hops = v ? Number(v) : 1;
    // Fastify's types don't accept a bare number, so express "trust N hops" as
    // the equivalent trust function (hop 0 is the socket peer / immediate proxy).
    return (_addr: string, hop: number) => hop < hops;
  })() as string[] | ((addr: string, hop: number) => boolean),
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
  // Where infra alerts go. Email (via Resend) defaults to the waitlist address;
  // an optional webhook (Slack/Discord incoming webhook) also receives JSON.
  alertEmail: env.ALERT_EMAIL || env.WAITLIST_NOTIFY_EMAIL || 'cube@sneakybox.com',
  alertWebhook: env.ALERT_WEBHOOK || '',
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
