const ORIGIN = 'https://www.smaac.nl';
const KEY = 'routes:current';
export const normalize = path => path.replace(/\/+$/, '') || '/';
export const explicit = path => /^\/(nl|en)(\/|$)/i.test(path);
export function bypass(path) {
  return /^\/(?:api|cdn-cgi|\.well-known)(?:\/|$)/i.test(path)
    || /\.[^/]+$/.test(path)
    || /^\/(?:access-denied|checkout|paypal-checkout|order-confirmation|log-in|sign-up|reset-password|update-password|user-account)(?:\/|$)/i.test(path);
}
export function language(request) {
  const saved = (request.headers.get('Cookie') || '').match(/(?:^|;\s*)smaac_lang=(nl|en)(?:;|$)/);
  if (saved) return saved[1];
  const choices = (request.headers.get('Accept-Language') || '').split(',').map((part, i) => {
    const [tag, ...params] = part.trim().toLowerCase().split(';');
    const qParam = params.map(p => p.trim()).find(p => p.startsWith('q='));
    const q = qParam === undefined ? 1 : (/^q=(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(qParam) ? Number(qParam.slice(2)) : 0);
    return { lang: tag.split('-')[0], q, i };
  }).filter(x => ['nl', 'en'].includes(x.lang) && x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  return choices[0]?.lang || 'en';
}
function destination(group, lang, search) {
  if (!group || typeof group !== 'object') return null;
  const path = group[lang] || group.default || group.en || group.nl;
  // Defense in depth against a malformed manifest or open redirects.
  if (!path || !/^\/(nl|en)(?:\/|$)/.test(path) || /[?#\\]/.test(path)) return null;
  const url = new URL(path, ORIGIN);
  if (url.origin !== ORIGIN) return null;
  url.search = search;
  return url.href;
}
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Accept-Language, Cookie' };
function redirect(location) {
  return new Response(null, { status: 302, headers: { ...headers, Location: location } });
}
function preview(path, lang, location, reason) {
  return Response.json({ path, language: lang, action: location ? 'redirect' : 'pass-through', status: location ? 302 : null, location, reason }, { headers });
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const dry = env.DRY_RUN !== 'false';
    const path = normalize(url.pathname);
    const lang = language(request);
    const pass = reason => dry ? preview(path, lang, null, reason) : fetch(request);
    if (!dry && !['smaac.nl', 'www.smaac.nl'].includes(url.hostname)) return new Response('Not found', { status: 404 });
    if (!['GET', 'HEAD'].includes(request.method) || explicit(path) || bypass(path)) return pass('explicit locale, technical path or method');
    let manifest;
    try {
      manifest = await env.ROUTES.get(KEY, { type: 'json', cacheTtl: 60 });
      if (manifest?.schema !== 1 || !manifest.aliases || !manifest.localized || !Array.isArray(manifest.groups)) return pass('manifest unavailable');
    } catch (error) {
      console.error('Route manifest unavailable', String(error));
      return pass('manifest unavailable');
    }
    const id = Object.hasOwn(manifest.aliases, path) ? manifest.aliases[path] : undefined;
    const location = id === undefined ? null : destination(manifest.groups[id], lang, url.search);
    if (location) return dry ? preview(path, lang, location, 'sitemap alias') : redirect(location);
    if (dry) return preview(path, lang, null, 'unknown alias; production would use origin');
    // Preserve existing Webflow redirects. If they point directly at a known
    // localized page, select its paired locale without inventing an alias.
    const response = await fetch(request, { redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const targetHeader = response.headers.get('Location');
    if (!targetHeader) return response;
    let target;
    try { target = new URL(targetHeader, url); } catch { return response; }
    if (target.protocol !== 'https:' || !['smaac.nl', 'www.smaac.nl'].includes(target.hostname)) return response;
    const targetPath = normalize(target.pathname);
    const targetId = Object.hasOwn(manifest.localized, targetPath) ? manifest.localized[targetPath] : undefined;
    if (targetId === undefined) return response;
    const neutralTarget = targetPath.replace(/^\/(nl|en)(?=\/|$)/, '') || '/';
    if (bypass(neutralTarget)) return response;
    // Origin controls any query transformations in its redirect. Direct sitemap
    // aliases above retain the original query exactly (including UTM parameters).
    const remapped = destination(manifest.groups[targetId], lang, target.search);
    if (!remapped) return response;
    await response.body?.cancel();
    return redirect(remapped);
  }
};
