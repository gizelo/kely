import { config } from "./config";

export function allowedLocalHost(request: Request) {
  const host = (request.headers.get("host") ?? "").toLowerCase();
  return config.origins.some(origin => new URL(origin).host === host);
}

export function allowedRequestOrigin(request: Request) {
  return config.origins.includes(request.headers.get("origin") ?? "");
}

export function localHostDenied() {
  return Response.json({ error: { code: "origin_denied", message: "This request is not allowed." } }, { status: 403 });
}
