import { verifyAdminSecret, verifyInstructorCookie } from './secrets';

// The instructor is whoever holds the session cookie set at first-run claim,
// or whoever presents the instructor password over HTTP Basic auth.
export async function isWorkshopAdmin(request: Request | Headers): Promise<boolean> {
  const headers = request instanceof Headers ? request : request.headers;
  if (await verifyInstructorCookie(headers.get('cookie'))) return true;
  const authorization = headers.get('authorization');
  if (!authorization?.startsWith('Basic ')) return false;
  try {
    const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
    const supplied = decoded.slice(decoded.indexOf(':') + 1);
    return await verifyAdminSecret(supplied);
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
