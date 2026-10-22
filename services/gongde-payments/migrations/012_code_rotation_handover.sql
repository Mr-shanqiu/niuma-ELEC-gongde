-- Manual code rotation keeps the replaced code usable for a one-hour handover.
--
-- A rotate has always bumped the family generation, which revoked the replaced
-- token outright. After this migration a rotate instead records when the
-- replaced token stops accepting NEW claims; the token row itself stays
-- readable so a session that verified with the old code can still finish a
-- claim inside the handover. Nothing is ever extended: the column is only
-- written at the moment of that token's own replacement, with the timestamp
-- taken from the same server clock as the rotation transaction.
--
-- Every existing row is left NULL, which is exactly the old behaviour: no
-- handover, the generation check in #authorize() refuses it.
--
-- server_rotated_at is the other half of the rule: a code that was replaced by
-- a rotation is only usable for NEW claims when the server says the rotation
-- really happened. Requiring it (rather than inferring "old generation") keeps
-- the ordinary 72-hour cycle boundary out of the handover entirely.
ALTER TABLE gongde_free_code_tokens
  ADD COLUMN handover_until DATETIME(3) NULL AFTER expires_at,
  ADD COLUMN server_rotated_at DATETIME(3) NULL AFTER handover_until,
  ADD KEY ix_free_token_handover (handover_until);
