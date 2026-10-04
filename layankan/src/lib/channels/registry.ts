import type { ChannelAdapter, ChannelProvider } from "./types";
import { webAdapter } from "./web";
import { metaCloudAdapter } from "./whatsapp/meta";
import { murpatiAdapter } from "./whatsapp/murpati";
import { metaInstagramAdapter, metaMessengerAdapter } from "./meta-messaging/adapters";

/**
 * Provider → adapter. Which provider a tenant uses is DATA
 * (channel_connections.provider), so switching transport is a row update, not
 * a code change.
 */
const adapters: Partial<Record<ChannelProvider, ChannelAdapter>> = {
  web: webAdapter,
  meta_cloud: metaCloudAdapter,
  murpati: murpatiAdapter,
  meta_messenger: metaMessengerAdapter,
  meta_instagram: metaInstagramAdapter,
};

export function getAdapter(provider: ChannelProvider): ChannelAdapter {
  const a = adapters[provider];
  if (!a) throw new Error(`No channel adapter registered for provider "${provider}"`);
  return a;
}

export function registerAdapter(provider: ChannelProvider, adapter: ChannelAdapter) {
  adapters[provider] = adapter;
}

/** Every registered adapter (used by the adapter contract tests and the admin console). */
export function listAdapters(): [ChannelProvider, ChannelAdapter][] {
  return Object.entries(adapters) as [ChannelProvider, ChannelAdapter][];
}
