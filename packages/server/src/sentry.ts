import * as Sentry from '@sentry/node';

// Privacy: never send contact emails, request bodies, cookies or headers to Sentry.
export function initSentry(dsn: string | undefined): boolean {
  if (!dsn) return false;
  Sentry.init({
    dsn,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
    beforeSend(event) {
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        delete event.request.headers;
        delete event.request.query_string;
      }
      delete event.user;
      return event;
    },
  });
  return true;
}

export { Sentry };
