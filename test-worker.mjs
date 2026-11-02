import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import worker, { language, explicit, bypass } from './worker.mjs';

const manifest = JSON.parse(await fs.readFile(new URL('./routes.json', import.meta.url)));
let assertions = 0;
function eq(actual, expected) { assert.deepEqual(actual, expected); assertions++; }
const env = { DRY_RUN: 'false', ROUTES: { get: async () => manifest } };
const req = (path, headers = {}, method = 'GET') => new Request('https://www.smaac.nl' + path, { headers, method });
const originalFetch = globalThis.fetch;
let originCalls = 0;
try {
  globalThis.fetch = async () => { originCalls++; return new Response('origin', { status: 200 }); };
  for (const [header, expected] of [
    ['nl-NL,nl;q=0.9,en;q=0.8', 'nl'], ['en;q=0.9,nl;q=0.5', 'en'],
    ['nl;q=0,en;q=0.5', 'en'], ['de,fr', 'en'], ['nl;q=garbage,en', 'en'],
    ['en;q=0.5,nl;q=0.5', 'en'], ['nl;q=2,en;q=0.7', 'en']
  ]) eq(language(req('/', { 'Accept-Language': header })), expected);
  eq(language(req('/', { Cookie: 'x=y; smaac_lang=nl; test=1', 'Accept-Language': 'en' })), 'nl');
  eq(language(req('/', { Cookie: 'not_smaac_lang=nl', 'Accept-Language': 'en' })), 'en');
  for (const [alias, i] of Object.entries(manifest.aliases)) {
    if (explicit(alias) || bypass(alias)) continue;
    const group = manifest.groups[i];
    for (const lang of ['nl', 'en']) {
      const res = await worker.fetch(req(alias + '?utm_source=test&x=1', { 'Accept-Language': lang }), env);
      eq(res.status, 302);
      eq(res.headers.get('Location'), 'https://www.smaac.nl' + (group[lang] || group.default || group.en || group.nl) + '?utm_source=test&x=1');
      eq(res.headers.get('Cache-Control'), 'private, no-store');
    }
  }
  // Explicit locale URLs always bypass KV and the router, regardless of preference.
  for (const path of Object.keys(manifest.localized)) {
    const res = await worker.fetch(req(path, { 'Accept-Language': 'nl', Cookie: 'smaac_lang=en' }), { DRY_RUN: 'false', ROUTES: { get: () => { throw Error('must not read KV'); } } });
    eq(await res.text(), 'origin');
  }
  for (const path of ['/nl/', '/en/', '/robots.txt', '/sitemap.xml', '/cdn-cgi/test', '/.well-known/test', '/checkout']) {
    eq(await (await worker.fetch(req(path), env)).text(), 'origin');
  }
  eq(await (await worker.fetch(req('/smaac/contact', {}, 'POST'), env)).text(), 'origin');
  eq((await worker.fetch(req('/smaac/contact', {}, 'HEAD'), env)).status, 302);
  eq((await worker.fetch(req('/brandhubs/forest-3', { 'Accept-Language': 'en' }), env)).headers.get('Location'), 'https://www.smaac.nl/en/brandhubs/forest3');
  eq((await worker.fetch(req('/brandhubs/forest3', { 'Accept-Language': 'nl' }), env)).headers.get('Location'), 'https://www.smaac.nl/nl/brandhubs/forest-3');
  eq(await (await worker.fetch(req('/unknown'), env)).text(), 'origin');
  eq(await (await worker.fetch(req('/'), { ...env, ROUTES: { get: async () => null } })).text(), 'origin');
  const preview = await (await worker.fetch(req('/smaac/contact'), { ...env, DRY_RUN: 'true' })).json();
  eq(preview.action, 'redirect');
  eq(preview.location, 'https://www.smaac.nl/en/smaac/contact');
  globalThis.fetch = async () => new Response(null, { status: 301, headers: { Location: '/smaac/contact' } });
  const legacy = await worker.fetch(req('/contact', { 'Accept-Language': 'nl' }), env);
  eq(legacy.status, 301); eq(legacy.headers.get('Location'), '/smaac/contact');
  globalThis.fetch = async () => new Response(null, { status: 302, headers: { Location: '/en/smaac/contact?source=origin' } });
  eq((await worker.fetch(req('/legacy', { 'Accept-Language': 'nl' }), env)).headers.get('Location'), 'https://www.smaac.nl/nl/smaac/contact?source=origin');
  globalThis.fetch = async () => new Response(null, { status: 302, headers: { Location: 'https://external.example/en/smaac/contact' } });
  eq((await worker.fetch(req('/legacy'), env)).headers.get('Location'), 'https://external.example/en/smaac/contact');
  console.log(JSON.stringify({ assertions, aliases: Object.keys(manifest.aliases).length, routableAliases: Object.keys(manifest.aliases).filter(p => !bypass(p) && !explicit(p)).length, localizedPaths: Object.keys(manifest.localized).length, originCalls, result: 'passed' }));
} finally { globalThis.fetch = originalFetch; }
