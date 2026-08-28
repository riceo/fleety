// One home for HTML/XML escaping — previously copied (and already drifting)
// across the OG shell, the email templates, and the share-card SVG.

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// SVG text also needs apostrophes escaped (attribute contexts use single quotes).
export function escapeXml(s: string): string {
  return escapeHtml(s).replace(/'/g, '&#39;');
}
