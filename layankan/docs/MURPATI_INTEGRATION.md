# Murpati integration: what we need before building it

**Status: NOT IMPLEMENTED.** The Murpati adapter (`src/lib/channels/whatsapp/murpati.ts`) is a clearly marked **stub**:

- It never makes a network call.
- Every send is recorded as `failed` with `MURPATI_NOT_IMPLEMENTED`.
- The webhook (`/api/webhooks/murpati/<connectionId>`) answers `501` and stores nothing.
- The dashboard won't let anyone connect a Murpati number or make one active.

Businesses connect **directly with Meta** in the meantime.

We deliberately do **not guess** Murpati's endpoints, payloads or signature scheme. When Murpati's official API documentation arrives, answer each question below **from the docs** (with a link or page reference), then build the adapter.

## Questions the docs must answer

| # | Question | Where it goes in our code |
|---|---|---|
| 1 | **Base URL** for the API (and a sandbox URL, if any) | new env var (e.g. `MURPATI_API_BASE_URL`), added to `src/lib/env.ts` + `.env.example` |
| 2 | **Authentication**: header name and format (Bearer token? API key header?) and how a key is scoped (per account or per device/number) | `sendMessage` in `murpati.ts`; credential names stored with `putCredential` |
| 3 | **Send a text message**: method, path and exact JSON body; how the recipient number is written (with `+` or not); max length | `sendMessage` + a pure `buildMurpatiSendBody()` with unit tests from the docs' examples |
| 4 | **Send an approved template**: body shape for name, language and variables (components? positional?) | same as 3 |
| 5 | **Send response**: where the WhatsApp message id is (so delivery receipts can be matched); error format and codes | `sendMessage` return value |
| 6 | **Webhook events**: event names and full example payloads for an incoming message, a delivery/read receipt, a failed message, and a message sent from Murpati's own dashboard | a pure `parseMurpatiWebhook()` → `NormalizedEvent[]`, with the docs' examples as test fixtures |
| 7 | **Webhook signature**: header name(s), the exact string that is signed (body only? timestamp + body?), algorithm, and how the secret is encoded; replay window | `src/lib/channels/signature.ts` (one exact scheme, no fallbacks) |
| 8 | **Official vs unofficial numbers**: how a payload or account tells us the number is on the **official WhatsApp Business API** and not a QR-linked device | parser must refuse unofficial devices (our rule: official API only) |
| 9 | **24-hour window**: does Murpati enforce it, or pass Meta's errors through? Error code when a free-text message is sent outside the window | map to our `ServiceWindowClosedError` handling |
| 10 | **Media** (images, documents, voice): payload shape, so we can store a placeholder like `[Gambar]` | parser |
| 11 | **Rate limits** and retry guidance | `sendMessage` (timeouts / retry policy) |
| 12 | **Data retention**: what Murpati stores, for how long, and how to request deletion (PDPA) | `EXIT_RUNBOOK.md` step 7 |

## Rules that do not change (our requirements, not Murpati's)

- **Transport only.** Never store the Business Brain, prompts, lead scores or customer history in Murpati. Never use Murpati's AI or document features. Our database is the system of record: every message is saved before sending and on receipt.
- **Official WhatsApp API numbers only.** Unofficial or QR-linked devices are refused.
- **Verify every webhook signature** before reading the payload.
- **Credentials are encrypted** in `channel_credentials` (AES-256-GCM, rotatable) and never logged.
- The adapter must pass `tests/adapter-contract.test.ts`, like every other transport.

## Definition of done for the real adapter

1. Every answer above is filled in, with a reference to the docs.
2. `murpati.ts` implements `receiveMessage` and `sendMessage`. `metadata().available` becomes `true`. The webhook route runs the same flow as `/api/webhooks/meta` (verify → `receiveMessage` → `ingestEvents` → `respondIfLatest`).
3. Unit tests use the docs' own example payloads and signatures, for parsing, building requests, verifying signatures and refusing unofficial devices.
4. The stub-only tests in `tests/adapter-contract.test.ts` (the "Murpati adapter is a clearly marked STUB" block) are replaced by real ones.
5. The dashboard connect form (`connectMurpati`) is restored. A sandbox number is tested end to end before any client is onboarded.
6. `EXIT_RUNBOOK.md` is re-verified with a real Murpati number (Murpati → Meta switch).
