// OPTIONAL Webflow footer code. Proposed only; not installed on the live site.
// Wrap in <script>...</script> when adding to Webflow custom code.
document.addEventListener('click', event => {
  const link = event.target.closest?.('.w-locales-item a[hreflang][href]');
  if (!link) return;
  const lang = link.hreflang.toLowerCase().split('-')[0];
  if (!['nl', 'en'].includes(lang)) return;
  const target = new URL(link.href, location.href);
  if (!['www.smaac.nl', 'smaac.nl'].includes(target.hostname)) return;
  document.cookie = `smaac_lang=${lang}; Path=/; Domain=smaac.nl; Max-Age=31536000; SameSite=Lax; Secure`;
});
