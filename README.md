# BNI IKON — Visitor Database & Coffee Session Booking

One shared link for the whole chapter: https://usayrikausar.github.io/BNIIKonCoffeeSession/

- **Add Visitor**: every online or offline visitor (chapter meeting, event, referral, coffee session).
- **Visitor Database**: the master list. One row per person, matched by phone number so the same person isn't added twice. It also has the WhatsApp / Copy buttons for the two registration links.
- **Coffee Session**: slot booking (2 teams × 3 sessions), a schedule image for WhatsApp, and calendar invites. Each booking automatically creates or updates the visitor.
- **Report**: visitor totals, follow-up funnel, breakdown by source and by inviter, and coffee session outcomes.
- **Admin** (passcode): blocked dates and the data-source URL.

## Files

| File | What it is |
|---|---|
| `index.html` | The whole app. Settings (links, passcode, sources, statuses, teams, sessions) are in the `CONFIG` block at the top of the script. |
| `google-apps-script-backend.gs` | Backend code that runs inside the Google Sheet (Extensions → Apps Script). |

## Google Sheet

The script manages three tabs and adds any missing columns itself. You don't need to edit them by hand.

- `Visitors`: the master visitor list
- `Bookings`: coffee session slots, linked to a visitor by `visitorId`
- `BlockedDates`

## Updating the backend (keeps the same URL)

1. In the Sheet, go to Extensions → Apps Script, replace `Code.gs` with `google-apps-script-backend.gs`, then click Save.
2. Deploy → **Manage deployments** → click the pencil on the existing deployment → Version: **New version** → Deploy.

Do **not** use "New deployment". That creates a different URL, and the app would need updating to point to it. Don't press "Run" on any function either.
