let csrfToken: string | undefined;
export const setCsrf = (t: string | undefined) => {
  csrfToken = t;
};

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (csrfToken && method !== 'GET') headers['x-csrf-token'] = csrfToken;
  const res = await fetch(url, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; message?: string };
    throw new ApiError(res.status, d.error ?? 'error', d.message ?? 'Something went wrong. Please try again.');
  }
  return data as T;
}

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : 'Something went wrong.');

/** Uploads one file (multipart) with the same sign-in and CSRF protection as every other request. */
export async function upload<T = unknown>(url: string, file: File): Promise<T> {
  const form = new FormData();
  form.append('file', file);
  const headers: Record<string, string> = {};
  if (csrfToken) headers['x-csrf-token'] = csrfToken;
  const res = await fetch(url, { method: 'POST', headers, credentials: 'same-origin', body: form });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; message?: string };
    throw new ApiError(res.status, d.error ?? 'error', d.message ?? 'The upload failed. Please try again.');
  }
  return data as T;
}

/** "asset:<id>" is how emails refer to library pictures; the browser loads them from /media/<id>. */
export const pictureSrc = (v: string): string => (v.startsWith('asset:') ? `/media/${v.slice(6)}` : v);
