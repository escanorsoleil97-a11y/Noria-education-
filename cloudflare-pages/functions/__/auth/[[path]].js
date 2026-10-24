export async function onRequest({ request }) {
  const u = new URL(request.url);
  return fetch(new Request(new URL(u.pathname + u.search, "https://statanalyse-pro.firebaseapp.com"), request));
}
