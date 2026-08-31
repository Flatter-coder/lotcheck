-- An UNSIGNED provider event must not become a delivery record.
--
-- WHAT WAS WRONG. v_report_delivery_status computed delivered_at / bounced_at /
-- complained_at from every event, with no signature condition:
--
--     max(e.created_at) filter (where e.kind = 'delivered') as delivered_at
--
-- and resend-webhook records an event even when it cannot verify the signature
-- (sig_verified = false) and answers 200. RESEND_WEBHOOK_SECRET is not
-- configured on this project at all, so EVERY provider event recorded to date is
-- unverified -- and each one still lands in that view as a delivered_at
-- timestamp indistinguishable from a real delivery.
--
-- The endpoint takes no JWT (webhooks cannot present one). So anyone who learns
-- the URL can POST {type: "email.delivered", ...} and write "we delivered it"
-- into the ledger that IS our record of having sent a report. That ledger is
-- what [[make-it-dispute-proof]] and [[storage-promise-vs-delivery-ledger]]
-- rest on: it is the answer to "did LotCheck send this", and an answer anyone
-- can write is not evidence.
--
-- THE ORIGINAL COMMENT WAS HALF RIGHT, and that is why this survived. It said:
--
--     Note the absence of any `sig_verified` filter: our own accepted/queued
--     events carry no signature, and filtering on it would silently hide every
--     send from its own status view.
--
-- True -- for INTERNAL events, which we insert ourselves and which are already
-- trustworthy by construction. It does not follow for PROVIDER events, which
-- arrive over an unauthenticated public endpoint. One filter for both kinds
-- meant the honest need of the first set the rule for the second.
--
-- THE FIX. An event counts if we wrote it OURSELVES, or if it came from the
-- provider AND its signature verified. Internal events are untouched, so no
-- send disappears from its own status view.
--
-- FAIL-SAFE DIRECTION. With the secret unset, provider events stop counting --
-- delivered_at goes NULL rather than reading as delivered. That is the correct
-- direction for this project: a delivery we cannot prove must read as unproven,
-- never as confirmed. [[report-never-empty]] does not apply -- this is not a
-- gap in a buyer's report, it is a claim we would otherwise be making without
-- evidence, and missing beats wrong.
--
-- The unverified rows are NOT deleted. They stay as an audit trail, which is
-- how a forgery attempt would be noticed at all, and they remain visible to
-- fn_admin_delivery_ledger.

create or replace view public.v_report_delivery_status as
select d.id,
       d.created_at,
       d.recipient_domain,
       d.pdf_sha256,
       d.pdf_bytes,
       d.provider_msg_id,
       d.accepted,
       d.error_code,
       d.capture_attached,
       d.signature_ok,
       max(e.created_at) filter (
         where e.kind = 'delivered'  and (e.origin <> 'provider' or e.sig_verified)
       ) as delivered_at,
       max(e.created_at) filter (
         where e.kind = 'bounced'    and (e.origin <> 'provider' or e.sig_verified)
       ) as bounced_at,
       max(e.created_at) filter (
         where e.kind = 'complained' and (e.origin <> 'provider' or e.sig_verified)
       ) as complained_at,
       -- Opens are recorded but are NOT evidence: image blocking suppresses
       -- them and Apple Mail Privacy Protection manufactures them. The absence
       -- of an open proves nothing. Never argue from this column.
       max(e.created_at) filter (
         where e.kind = 'opened'     and (e.origin <> 'provider' or e.sig_verified)
       ) as opened_at_weak,
       -- Surfaced, not hidden. A provider event we could not verify is a fact
       -- worth seeing: it means either the secret is unset, or somebody is
       -- forging events at us. Both need a person, and a count nobody can see
       -- is how the first one lasted this long.
       count(*) filter (
         where e.origin = 'provider' and not e.sig_verified
       ) as unverified_provider_events
  from report_delivery d
  left join report_delivery_event e on e.delivery_id = d.id
 group by d.id;
