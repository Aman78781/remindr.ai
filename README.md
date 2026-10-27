# reminder.ai — Study, exam planner, and WhatsApp reminders

This package keeps the current reminder.ai branding, teacher-guided AI revision, manual Study Plans, and adds an **opt-in Twilio WhatsApp sender** for exam reminders. Students can select 7 days, 3 days, 1 day, and exam-day reminders, and must explicitly opt in to WhatsApp. Existing students are opted out until they enable it in Settings.

**Start here:**
- `START-HERE-TWILIO-WHATSAPP.txt` — Twilio Sandbox setup, Script Properties, test message, and automated reminder test.
- `START-HERE-MANUAL-STUDY-PLANS.txt` — general app update, backup, Apps Script deployment, and website/logo instructions.

The sender uses Twilio's standard WhatsApp appointment-reminder template by default (two content variables). For a short judge demo, `TWILIO_SANDBOX_FREEFORM=true` sends the custom reminder text during the 24-hour Sandbox window opened by `join`. Sandbox cannot use custom templates; production use requires a registered sender and an approved template. LMS syncing and DNS/domain setup are not included.
