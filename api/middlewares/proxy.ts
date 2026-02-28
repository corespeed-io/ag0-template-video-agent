import type { MiddlewareHandler } from "hono";
import { proxy as honoProxy } from "hono/proxy";

/**
 * Reverse proxy middleware that forwards HTTP requests and WebSocket
 * connections to an upstream origin.
 *
 * The built-in `hono/proxy` does not support WebSocket upgrades,
 * so this middleware handles them manually.
 */
export function proxy(
  origin: string,
  options: { stripPrefix?: string } = {},
): MiddlewareHandler {
  const { stripPrefix = "" } = options;
  const base = new URL(origin);
  // Strip trailing slash to avoid double slashes when joining with target.pathname
  const basePath = base.pathname.replace(/\/$/, "");

  return async (c) => {
    const target = new URL(c.req.url);
    target.host = base.host;
    target.protocol = base.protocol;
    const rawPath = target.pathname;
    const strippedPath =
      stripPrefix && rawPath.startsWith(stripPrefix)
        ? rawPath.slice(stripPrefix.length) || "/"
        : rawPath;
    target.pathname = basePath + strippedPath;

    // WebSocket upgrade
    if (c.req.header("upgrade")?.toLowerCase() === "websocket") {
      const { socket, response } = Deno.upgradeWebSocket(c.req.raw);
      target.protocol = base.protocol === "https:" ? "wss:" : "ws:";
      const upstream = new WebSocket(target);

      upstream.onopen = () => {
        socket.onmessage = (e) => upstream.send(e.data);
      };
      upstream.onmessage = (e) => socket.send(e.data);
      upstream.onclose = () => socket.close();
      socket.onclose = () => upstream.close();

      return response;
    }

    // HTTP proxy
    return await honoProxy(target.href, { raw: c.req.raw });
  };
}
