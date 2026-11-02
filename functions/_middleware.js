// Cloudflare Pages Function : transmet /.netlify/functions/* vers Netlify côté serveur.
// Le navigateur ne contacte donc plus jamais *.netlify.app (utile quand ce domaine est bloqué).
// Variable optionnelle (Cloudflare > Settings > Variables) : API_ORIGIN = https://votre-site.netlify.app
const DEFAULT_API_ORIGIN = 'https://noria-education.netlify.app';

export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (!url.pathname.startsWith('/.netlify/functions/')) return context.next();

  const apiOrigin = String((context.env && context.env.API_ORIGIN) || DEFAULT_API_ORIGIN).replace(/\/$/, '');
  const target = apiOrigin + url.pathname + url.search;

  const headers = new Headers(context.request.headers);
  headers.delete('host');
  const ip = context.request.headers.get('CF-Connecting-IP');
  if (ip) headers.set('x-forwarded-for', ip);

  const method = context.request.method;
  const hasBody = method !== 'GET' && method !== 'HEAD';
  try {
    const res = await fetch(target, {
      method,
      headers,
      body: hasBody ? context.request.body : undefined,
      redirect: 'manual',
    });
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Passerelle Netlify injoignable : ' + (e && e.message || e) }), {
      status: 502, headers: { 'Content-Type': 'application/json' },
    });
  }
}
