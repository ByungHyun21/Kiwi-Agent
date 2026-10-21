// Bearer-token authentication shared by the REST API and the WS upgrade.

/** bearerToken reads the token from Authorization or ?token=. */
export function bearerToken(req: Request, url?: URL): string {
  const auth = req.headers.get("Authorization") ?? "";
  if (auth.startsWith("Bearer ")) return auth.slice("Bearer ".length);
  return url?.searchParams.get("token") ?? "";
}

/** isAuthorized reports whether the request may proceed. */
export function isAuthorized(srv: { token: string; authRequired: boolean }, req: Request, url?: URL): boolean {
  if (!srv.authRequired) return true;
  return bearerToken(req, url) === srv.token;
}
