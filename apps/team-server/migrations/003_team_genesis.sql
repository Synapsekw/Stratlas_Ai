-- Team Server: the genesis pin of each team project (security review 2026-10-21, with the
-- journal's team.json genesis): the op that made the first owner and the history it was shared
-- with, as the server first saw them. Set once; only that op makes the first owner.

ALTER TABLE projects ADD COLUMN genesis text;
