// Signs local test JWTs with the stack's secret. Usage:
//   node jwt.mjs role <service_role|anon>          → JWT
//   node jwt.mjs cookie <user-uuid> <email>        → Supabase SSR session cookie (name=value)
import { createHmac } from "node:crypto";
export const SECRET = "super-secret-jwt-token-with-at-least-32-characters";
const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
export function sign(payload) {
  const h = b({ alg: "HS256", typ: "JWT" }), p = b({ exp: 4102444800, ...payload });
  return `${h}.${p}.${createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url")}`;
}
export function sessionCookie(uid, email) {
  const access_token = sign({ sub: uid, email, role: "authenticated", aud: "authenticated" });
  const session = { access_token, refresh_token: "x", token_type: "bearer", expires_in: 999999, expires_at: 4102444800, user: { id: uid, email, aud: "authenticated", role: "authenticated" } };
  return `sb-127-auth-token=base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
}
if (process.argv[1]?.endsWith("jwt.mjs")) {
  const [cmd, a, b2] = process.argv.slice(2);
  process.stdout.write(cmd === "role" ? sign({ role: a, iss: "supabase" }) : sessionCookie(a, b2));
}
