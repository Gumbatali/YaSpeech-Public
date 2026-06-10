/**
 * Табличный роутер вместо цепочки if-ов.
 *
 * Паттерн — путь с параметрами: "/api/meetings/:id/confirm-draft".
 * Совпадение — по методу, числу сегментов и каждому сегменту;
 * сегменты вида ":name" попадают в params.
 *
 * Хендлер получает ctx: { request, response, url, params, currentUser }.
 */
export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    this.routes.push({
      method,
      segments: pattern.split("/").filter(Boolean),
      handler
    });
    return this;
  }

  match(method, parts) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;

      const params = {};
      let matched = true;
      for (let i = 0; i < parts.length; i++) {
        const segment = route.segments[i];
        if (segment.startsWith(":")) {
          params[segment.slice(1)] = parts[i];
        } else if (segment !== parts[i]) {
          matched = false;
          break;
        }
      }
      if (matched) {
        return { handler: route.handler, params };
      }
    }
    return null;
  }
}
