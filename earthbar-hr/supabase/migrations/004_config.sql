-- ============================================================================
-- Earthbar HR Case Management — 004 Config seed
-- Escalation matrix (by title) and the external fallback advisor.
-- Edit these to change who handles cases — routing follows automatically.
-- ============================================================================

-- Escalation matrix, in order. Whoever currently holds the title is the handler.
insert into handler_roles(title, rank, is_admin) values
  ('HR Generalist',            1, false),
  ('HR Coordinator',           2, false),
  ('Director of HR',           3, true),
  ('VP of People and Culture', 4, true)
on conflict (title) do update
  set rank = excluded.rank, is_admin = excluded.is_admin;

-- The last-resort handler when every internal HR person is conflicted.
-- >>> REPLACE with the real outside counsel / board contact / ethics hotline. <<<
insert into external_advisor(id, name, email, note) values
  (true, 'External Advisor (TO BE DESIGNATED)', null,
   'Placeholder — replace name/email with outside employment counsel, a board/audit-committee contact, or a third-party ethics hotline.')
on conflict (id) do nothing;
