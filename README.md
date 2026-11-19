# Ramps Sponsorship Hub

Ramps Logistics Corporate Communications Department.

- `index.html`: the Microsoft sign-in page (a design preview, which doesn't sign anyone in yet).
- `hub.html`: the Sponsorship Hub.
- `ramps-logo.webp`: the logo. It is already embedded in both pages, so this copy is only for reference.

## Status

These pages were built to run on claude.ai. On GitHub Pages they load and look right, but the hub opens **view-only**:
saving requests, reading attachments with Claude, admin review and stored reports all need a backend.

Planned stack: Supabase (database, file storage, Microsoft/Azure sign-in), Resend or Microsoft Graph (emails),
and a server-side function for document scoring.
