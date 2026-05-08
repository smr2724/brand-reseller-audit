-- Phase 52 — extend brand_contacts.email_status to distinguish a
-- contact for whom no email could be found (Apollo/Hunter both empty)
-- from a contact whose email is present but unverified.
--
-- Existing values: verified, likely, risky, catch_all, guessed, bounced,
-- invalid, unknown.
-- New value: not_found.

ALTER TABLE brand_contacts
  DROP CONSTRAINT IF EXISTS brand_contacts_email_status_check;

ALTER TABLE brand_contacts
  ADD CONSTRAINT brand_contacts_email_status_check
  CHECK (email_status IN (
    'verified','likely','risky','catch_all','guessed',
    'bounced','invalid','unknown','not_found'
  ));
