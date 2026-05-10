import { createRuntimeServer } from "./server/runtime-server.js";

export async function createTestServer(options) {
  return createRuntimeServer(options);
}
