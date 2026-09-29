-- The guest download page (download/) opens a single photo by its exact
-- public URL: captures/<event_id>/<captureId>.jpg. A public bucket serves an
-- object only by exact path; listing needs a SELECT policy, and after this
-- migration anon has none. The capture id is a random UUID, so only someone
-- given the QR code can open that photo.
--
-- The two anon policies from 20260814000000_captures.sql are dropped: with
-- them, anyone holding the anon key could list and download every capture.
-- booth-agent uses the service-role key, which bypasses RLS, so its uploads
-- and the captures upsert are unaffected.

update storage.buckets set public = true where id = 'captures';

drop policy if exists "anon can read capture files" on storage.objects;
drop policy if exists "anon can read captures" on public.captures;
