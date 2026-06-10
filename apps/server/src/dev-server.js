import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntimeServer } from "./server/runtime-server.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(currentDirectory, "../../..", ".local-data");

const server = await createRuntimeServer({
  dataDir,
  port: Number(process.env.PORT ?? 8787),
  // Локальная auth-цепочка: задайте SESSION_SECRET (+ опц. ADMIN_LOGIN),
  // чтобы проверять вход/регистрацию/админку без облака.
  sessionSecret: process.env.SESSION_SECRET ?? null,
  adminLogin: process.env.ADMIN_LOGIN ?? null
});

await server.start();

console.log(`YaSpeech API listening on ${server.baseUrl}`);
