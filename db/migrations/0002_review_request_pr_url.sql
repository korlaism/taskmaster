-- The git-integration ingestion pipeline that would populate pull_requests rows from
-- real webhooks is a later phase (docs/09). Until then, a developer requesting review
-- can supply a raw PR URL directly so the reviewer's card still shows "Open PR" —
-- pull_request_id stays the FK for when real PR linkage exists.
ALTER TABLE review_requests ADD COLUMN pull_request_url TEXT;
