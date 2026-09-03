import { timingSafeEqual } from 'node:crypto';

function secret(): string | undefined {
  return process.env.WORKSHOP_ADMIN_SECRET;
}

export function isWorkshopAdmin(request: Request | Headers): boolean {
  const expected = secret();
  if (!expected) return false;
  const headers = request instanceof Headers ? request : request.headers;
  const authorization = headers.get('authorization');
  if (!authorization?.startsWith('Basic ')) return false;
  try {
    const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
    const supplied = decoded.slice(decoded.indexOf(':') + 1);
    const suppliedBuffer = Buffer.from(supplied);
    const expectedBuffer = Buffer.from(expected);
    return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
  } catch {
    return false;
  }
}

export function workshopUnauthorized(): Response {
  return Response.json(
    { error: 'unauthorized' },
    {
      status: 401,
      headers: {
        'www-authenticate': 'Basic realm="Workshop instructor", charset="UTF-8"',
        'cache-control': 'no-store',
      },
    },
  );
}
