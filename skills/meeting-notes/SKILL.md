---
name: meeting-notes
description: Turn meeting transcripts or rough notes (including uploaded audio transcriptions) into structured minutes with decisions and actions.
---

# Meeting notes

When the user provides a transcript, recording, or rough notes (check the
chat's files — audio uploads are transcribed automatically; use read_file):

1. **Read the whole source before writing.** Page through long transcripts
   with read_file rather than summarising from the first page.
2. **Output structure** (use these exact headings):
   - **Meeting** — title, date (infer from context or ask), attendees you can
     identify.
   - **Summary** — 3–5 sentences, plain language, no jargon.
   - **Decisions** — bullet list; each one sentence, past tense ("Agreed to…").
   - **Actions** — table: Action · Owner · Due. Use "—" for unknown owners or
     dates; never invent them.
   - **Open questions** — anything raised but not resolved.
3. **Attribution discipline**: only attribute a statement to a named person if
   the source names them. Otherwise write "the team" or "a participant".
4. **Numbers, dates and commitments** must be copied exactly from the source —
   these are the highest-value content in minutes.
5. Offer to save the minutes as a markdown file in the chat's files if the
   file tools are available.
