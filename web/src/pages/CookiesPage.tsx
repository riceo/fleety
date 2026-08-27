import { Link } from 'react-router-dom';
import { FleetyMark } from '../components/TopBar';

// Cookie & data notice for the whole Fleety service (apex and club boards).
// Kept deliberately honest and short: one essential cookie, user-set
// preferences in local storage, cookieless analytics, and the waitlist.
export function CookiesPage() {
  return (
    <div className="doc-page">
      <div className="doc-inner">
        <Link to="/" className="doc-brand">
          <FleetyMark />
          <span className="brand-name">FLEETY</span>
        </Link>
        <h1>Cookies &amp; your data</h1>
        <p className="muted small">Effective 27 August 2026</p>

        <p>
          Fleety (fleety.live and each club's board at its own subdomain) is operated by AstraMesa, a trading
          name of Platformation Ltd, registered in England and Wales, company no. 10414067, registered office
          20-22 Wenlock Road, London, England, N1 7GU. Questions about anything here:{' '}
          <a href="mailto:ops@fleety.live">ops@fleety.live</a>.
        </p>

        <h2>Cookies we set</h2>
        <p>We set exactly one cookie, and only when you sign in or a kiosk screen is activated:</p>
        <table className="table">
          <thead>
            <tr>
              <th>Cookie</th>
              <th>Purpose</th>
              <th>Lifetime</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="mono">fv_session</td>
              <td>Keeps you signed in to your club's board (or keeps a clubhouse kiosk screen connected).</td>
              <td>Up to 1 year</td>
            </tr>
          </tbody>
        </table>
        <p>
          This cookie is strictly necessary to provide the service you asked for, so it doesn't require
          consent. We set no advertising, social-media or cross-site tracking cookies of any kind.
        </p>

        <h2>Local storage</h2>
        <p>
          If you use certain controls — for example turning event sounds on or off — your choice is remembered
          in your browser's local storage so it sticks next time. These values are set only when you use the
          control, stay on your device, and are never sent to us.
        </p>

        <h2>Analytics</h2>
        <p>
          We use PostHog (hosted in the EU) to understand how the service is used. It is configured
          cookielessly: it stores nothing on your device — no cookies, no local storage — so separate visits
          are not linked together. Basic technical data (pages viewed, browser type, IP address) is processed
          to deliver each request and produce aggregate usage statistics.
        </p>

        <h2>The waitlist</h2>
        <p>
          If you join the waitlist we store your email address and use it to contact you about getting your
          club set up. We only send product news if you ticked the optional updates box, and every such email
          lets you unsubscribe. To be removed from the waitlist entirely, email{' '}
          <a href="mailto:ops@fleety.live">ops@fleety.live</a>.
        </p>

        <h2>Changes</h2>
        <p>
          If we ever need cookies beyond the above — for example a future feature that requires consent —
          we'll update this page and ask first.
        </p>

        <p>
          <Link to="/">← Back to Fleety</Link>
        </p>
      </div>
    </div>
  );
}
