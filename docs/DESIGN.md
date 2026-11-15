# Deadline Crush: design (1 page)

**Goal:** 2,000 teams submit in the last 10 minutes; nothing is lost; the server, not the browser, decides what is on time.

## Upload flow
1. `POST /versions` creates version *N+1* (title, links, file name and size) and opens an S3 **multipart upload**. Metadata only, so it stays fast.
2. The browser asks for presigned `PUT` URLs (6 parts at a time, 8 MB each), uploads 3 parts in parallel **straight to object storage**, and acknowledges each part's ETag to the API. The API never receives file bytes (JSON body limit: 100 KB).
3. `POST /upload/complete` finalises the multipart upload, checks the stored size, marks the version `queued`, and enqueues a check job.
4. **Resume:** the DB records every acknowledged part, so `GET /upload` returns what is missing and the client sends only that. This survives a refresh, a crash, or going offline (the client waits for the `online` event and requests fresh URLs if they expired).

## Deadline and grace policy (server clock only, `lib/policy.ts`)
- A version may be **created** only while `now < deadline` (the exact deadline instant is refused).
- A version created before the deadline may **finish uploading** (presign, ack, complete) until `deadline + grace` (default 5 min). Grace never allows starting something new.
- Signed URLs expire at `min(15 min, deadline + grace − now)`, so none outlives the policy.
- **Every version is kept.** The version that counts is the latest one whose upload completed, so an unfinished upload can never overwrite an earlier good submission. Refusals are logged (`late attempts`).

## Exactly-once processing
BullMQ gives *at-least-once* delivery: a worker killed mid-job is detected by its expired lock and the job is re-delivered. Effects are made idempotent, so a re-run changes nothing:
- the result is one row per version behind a **unique index**, written with `$setOnInsert` (first writer wins, retries read the same row);
- previews use deterministic keys (`previews/<versionId>.*`), so retries overwrite instead of duplicating;
- the status change is a compare-and-set from `queued|checking`, and only the run that performs it emits the live event;
- `jobId = versionId` makes double-enqueue a no-op, and a **sweeper** re-enqueues versions stuck in `queued/checking` (covers a Redis wipe or a failed enqueue after upload completion).

Proven by tests that spawn real worker processes and `SIGKILL` them mid-job, including a 12-job burst: one result per version, one `accepted` event, nothing lost.

## Checks (worker, streaming from storage)
File type from magic bytes (PDF/ZIP only), zip central-directory inspection without extracting (entry count, total size, per-entry and overall compression ratio, nested archives, unsafe paths), link checks with an SSRF guard and redirect cap, and a preview (first PDF page via `mupdf`, or the zip README).

## Trade-offs
- **MongoDB, no transactions:** unique indexes, atomic `$inc`, and compare-and-set give the guarantees with one fewer moving part, and work on any Mongo tier.
- **SSE over WebSockets:** one-way status is all that is needed; it reconnects by itself and passes proxies. The client refetches on reconnect so nothing is missed.
- **Parts acknowledged by the client, not `ListParts`:** works on any S3-compatible store and keeps resume state queryable; a part uploaded but not acknowledged is simply re-sent.
- **Membership cached 10 s** in each API process to cut a DB read per request.

## Known limits
Tested against an in-process S3 server (`s3rver`) in CI and the load test, not against live MinIO/R2 multipart limits; no virus scanning; the link check resolves DNS before fetching (rebinding window); abandoned multipart uploads need a bucket lifecycle rule.

## One more week
Real MinIO/R2 in CI; ClamAV scan stage; per-team signed-URL budgets and per-IP rate limits tuned from the load test; emailed receipt with the file hash (the worker already computes SHA-256); horizontal API scale test (load test ran on one 2-core box with every component co-located); OpenTelemetry traces across API, queue and worker.
