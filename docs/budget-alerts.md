# Budget alert delivery

`checkBudgetsAfterChange` queues current-month alerts after persisted mutations.
Imports call it once after the transaction batch is inserted. The check uses
transaction dates and transaction categories, including descendant categories;
only negative amounts count. Reaching the limit exactly does not queue mail.
Users without email addresses do not consume their monthly notification slot.

The database enforces one notification per budget and UTC month. The first
queueing freezes the recipient, sender, subject, body, provider, limit and
spending. Subsequent checks never replace that snapshot, even if the category,
email address or limit changes. Delivery uses the generated idempotency key.

The existing maintenance loop starts on the first server request. Every 30
seconds it reconciles current-month budgets (recovering a crash or error between
financial persistence and queueing) and processes up to 50 notifications. It is
disabled in TEST_MODE; tests call maintenance or delivery explicitly. Financial
requests do not wait for the email provider and queue failures do not reverse
financial changes. Reconciliation observes current spending; it does not
reconstruct transient crossings that were subsequently edited away.

Workers claim notifications using `FOR UPDATE SKIP LOCKED`. A two-minute lease
recovers abandoned processing rows, and the attempt number fences late workers.
Provider requests time out after 15 seconds. Transient errors retry after one
minute with exponential backoff capped at one hour. Permanent HTTP rejections
stop automatic retries. Successful submission sets `sent` (provider acceptance,
not confirmation of delivery to the recipient's inbox).

## Uncertain delivery and operator review

Resend retains idempotency keys for [24 hours](https://resend.com/docs/dashboard/emails/idempotency-keys).
A network error or process crash can occur after the provider has accepted an
email. Every attempt therefore keeps its original payload, key and
`first_attempt_at`. Automatic retries stop at 23 hours, leaving a safety margin.
Notifications queued long ago but never attempted may still be sent.

Terminal rows have `status = 'failed'` and `next_retry_at IS NULL`:

- `delivery_window_expired_review_required`: acceptance is uncertain and the
  safe retry window has ended.
- `provider_rejected`: a permanent HTTP rejection requires investigation.
- `provider_changed_review_required`: configuration would send via a different
  provider, which cannot deduplicate the previous attempt.
- `missing_payload_review_required`: a legacy row lacks a frozen payload.

Keep these records: they retain the monthly deduplication slot. Investigate the
provider's records before taking manual action. Do not reset the idempotency key
or first-attempt timestamp to force retries; that can send duplicate alerts.
Provider response bodies and financial/email contents are not logged by the
delivery worker. The console email provider still prints email content as its
development delivery mechanism.
