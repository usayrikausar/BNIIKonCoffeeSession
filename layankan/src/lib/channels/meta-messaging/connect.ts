import "server-only";
import { env } from "@/lib/env";
import { graph } from "../whatsapp/meta";

// Connecting a business's OWN Facebook Page (and the Instagram professional
// account linked to it) with Facebook Login for Business.

export interface PageChoice {
  id: string;
  name: string;
  accessToken: string;
  instagram: { id: string; username: string | null } | null;
}

/** Login code → long-lived user token (Page tokens fetched with it don't expire). */
export async function userTokenFromCode(code: string): Promise<string> {
  const short = await graph<{ access_token?: string }>("oauth/access_token", {
    query: { client_id: env.metaAppId(), client_secret: env.metaAppSecret(), code },
  });
  if (!short.access_token) throw new Error("No access token returned by Meta");
  const long = await graph<{ access_token?: string }>("oauth/access_token", {
    query: { grant_type: "fb_exchange_token", client_id: env.metaAppId(), client_secret: env.metaAppSecret(), fb_exchange_token: short.access_token },
  });
  return long.access_token ?? short.access_token;
}

/** Pages this person manages, each with its Page token and linked Instagram account (if any). */
export async function listPages(userToken: string): Promise<PageChoice[]> {
  const d = await graph<{ data?: { id: string; name?: string; access_token?: string; instagram_business_account?: { id: string; username?: string } }[] }>("me/accounts", {
    token: userToken,
    query: { fields: "id,name,access_token,instagram_business_account{id,username}", limit: "100" },
  });
  return (d.data ?? [])
    .filter((p) => p.id && p.access_token)
    .map((p) => ({
      id: p.id,
      name: p.name ?? p.id,
      accessToken: p.access_token!,
      instagram: p.instagram_business_account?.id ? { id: p.instagram_business_account.id, username: p.instagram_business_account.username ?? null } : null,
    }));
}

/** Subscribe our app to the Page so its messages (and its Instagram account's) reach our webhook. */
export async function subscribePage(pageId: string, pageToken: string) {
  await graph(`${pageId}/subscribed_apps`, {
    method: "POST",
    token: pageToken,
    // "feed" = comments on the Page's posts (R5 comment-to-chat). Instagram comments come via the app's Instagram webhook.
    query: { subscribed_fields: "messages,messaging_postbacks,message_echoes,message_deliveries,message_reads,feed" },
  });
}
