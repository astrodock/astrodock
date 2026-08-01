-- Per-app branding for the hosted sign-in page.
--
-- The page is served by the platform, on the platform's origin — that is what
-- keeps an app from ever seeing a password. But nothing about that requires it
-- to look like a stranger's page, and it did: one generic form for every app.
-- These two columns are appearance only and change no security property.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS brand_color TEXT NOT NULL DEFAULT '';
ALTER TABLE apps ADD COLUMN IF NOT EXISTS logo_url TEXT NOT NULL DEFAULT '';
