-- ============================================================================
-- CCDT migration 007 — Fix peek_inbox to return O5 broadcasts
-- ============================================================================
-- Bug: peek_inbox filtered `where m.recipient = lower(p_username)` so the
-- O5 emergency broadcasts (which insert with recipient='*' to represent
-- "every member of the sender's vaults") never appeared in any inbox.
-- Effect: the 10-second inbox poller never saw O5 broadcasts and the O5
-- emergency popup (o5Popup.js) never fired for non-sender accounts.
--
-- Fix: also include rows where recipient='*' AND priority='o5' AND the
-- caller is a member of the row's vault. This makes the broadcast visible
-- to every vault member without leaking it to outsiders.
--
-- Also added is_broadcast flag and sender_id for client-side filtering
-- (so we can filter out "own broadcasts" without relying on sender_email).
-- ============================================================================

drop function if exists public.peek_inbox(citext, citext);

create function public.peek_inbox(p_username citext, p_vault_id citext default null)
returns table (
  id uuid, subject text, body text, priority text, classification text,
  sender_email text, sender_username citext,
  sender_id uuid,
  read_at timestamptz, created_at timestamptz, vault_id citext,
  is_broadcast boolean
) language sql stable security definer set search_path = public as $$
  select m.id, m.subject, m.body, m.priority, m.classification,
         au.email::text as sender_email,
         s.username as sender_username,
         m.sender_id,
         m.read_at, m.created_at, m.vault_id,
         (m.recipient = '*') as is_broadcast
  from public.messages m
  left join auth.users au on au.id = m.sender_id
  left join public.users s on s.id = m.sender_id
  where (
    -- Direct mail to me
    m.recipient = lower(p_username)
    -- OR an O5 broadcast (recipient='*') targeted at a vault I'm in
    or (
      m.recipient = '*'
      and m.priority = 'o5'
      and exists (
        select 1 from public.vault_members vm
        where vm.vault_id = m.vault_id and vm.user_id = auth.uid()
      )
    )
  )
    and (p_vault_id is null or m.vault_id = p_vault_id)
    and (
      public.user_clearance() >= 2
      or public.is_vault_member(coalesce(p_vault_id, m.vault_id))
      or (
        m.classification = 'PUBLIC'
        and public.vault_is_public(coalesce(p_vault_id, m.vault_id))
      )
    )
  order by m.created_at desc
  limit 200;
$$;

revoke execute on function public.peek_inbox(citext, citext) from public;
grant  execute on function public.peek_inbox(citext, citext) to authenticated;