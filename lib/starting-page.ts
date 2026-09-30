// Browser navigations during a Pocket ID cold start get this page instead of
// the proxy's JSON 503. It refreshes itself until Pocket ID answers.
export function isPageNavigation(request: Request): boolean {
  if (request.method !== 'GET') return false;
  const mode = request.headers.get('sec-fetch-mode');
  if (mode) return mode === 'navigate';
  return (request.headers.get('accept') ?? '').includes('text/html');
}

export const startingPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><meta http-equiv="refresh" content="4"><title>Starting…</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fafafa;color:#171717;font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}
main{width:min(440px,calc(100% - 32px));padding:28px;border:1px solid #eaeaea;border-radius:14px;background:#fff}
h1{margin:0 0 8px;font-size:22px;letter-spacing:-.02em}p{margin:0;color:#666}
</style></head><body><main>
<h1>Starting the workshop sign-in</h1>
<p>This takes a few seconds after a quiet period. The page reloads by itself.</p>
</main></body></html>`;
