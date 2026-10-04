-- R4 (ROADMAP.md): Instagram + Messenger, part 1 of 2.
-- New enum values must be committed before anything can use them, so this
-- file contains ONLY the enum changes. Run it on its own, then
-- 20261004000012_instagram_messenger.sql.
alter type public.channel_kind add value if not exists 'instagram';
alter type public.channel_kind add value if not exists 'messenger';
alter type public.channel_provider add value if not exists 'meta_instagram';
alter type public.channel_provider add value if not exists 'meta_messenger';
