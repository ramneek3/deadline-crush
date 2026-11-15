# Load-test report

**Question:** can the system take 2,000 teams submitting in the last 10 minutes, with p95 API latency under
300 ms, and without losing a single submission?

**Answer:** yes, on the final design. API p95 was **38 ms** and **174 ms** in the two final runs (two
resource configurations, below), with **0 failed requests** and **0 lost submissions**. The earlier runs missed the
target; they are reported too, because what they exposed shaped the design.

## Setup

| | |
|---|---|
| Machine | one VM, **2 vCPU / 8 GB**, Ubuntu 24.04. **Everything on it at once:** k6, the API, 2 worker processes (4 jobs each), MongoDB 7, Redis, and the storage stand-in |
| Storage | `s3rver` (a Node S3-compatible server writing to local disk) stands in for MinIO/R2; it speaks the same multipart + presigned-URL protocol, but it costs CPU on the same box, which real R2 would not |
| API | one Node 22 process, rate limiting off for the test |
| Tool | k6 0.54, scripts in [`loadtest/`](../loadtest) |
| Data | 2,000 teams (seeded), each uploads a 1.5 MB incompressible zip (3.1 GB uploaded in total) |

**Scenario** (`ramping-arrival-rate`, 10 minutes): 1 team/s for 6 min, rising to 5/s over 3 min, then a
**last-minute burst rising to 35 teams/s** (about 60% of all submissions land in the final minute). Each team: create
version, request part URL, PUT the file straight to storage, acknowledge the part, complete, then poll its
status every 1.5 s until a worker has checked it. A quarter of teams then submit a text-only edit, for **2,500
submissions in total**.

**p95 is measured on API calls only** (`http_req_duration{kind:api}`); the direct-to-storage PUTs are tagged
separately because they do not touch the API.

**"Nothing lost" is verified, not assumed.** Every submission the API acknowledges to a team is written to a
ledger. After the run, [`reconcile.ts`](../server/src/scripts/reconcile.ts) checks each ledger entry against the
database: it exists, was checked **exactly once**, is `accepted`, and the version that counts for each team is
its newest acknowledged one.

## Results

| Run | Change since previous | API p95 | API p99 | Failed API requests | Acknowledged | Lost |
|---|---|---|---|---|---|---|
| 1 | First full run | **603 ms** ✗ | 1,087 ms | 3 (`create` calls; cause not captured, see below) | 2,490 | 0 |
| 2 | Longer keep-alive timeout; cached membership lookup; audit writes off the request path | **383 ms** ✗ | 865 ms | 0 | not reconciled | n/a |
| 3 | Workers and storage stand-in at lower CPU priority (`nice 10`), to approximate running elsewhere | **326 ms** ✗ | 1,044 ms | 0 | 2,500 | 0 |
| 4 | **Upload finalisation moved from the request into the worker**; workers/storage at `nice 10` | **38 ms** ✓ | 84 ms | 0 | 2,500 | 0 |
| 5 | Same code as run 4, **all components at equal priority** (harshest setup) | **174 ms** ✓ | 282 ms | 0 | 2,500 | 0 |

Runs 4 and 5 are the final design. Run 5 is the honest worst case on this hardware; run 4 shows the API
when background work and storage do not compete with it for CPU, the way they would on separate hosts.

Per-endpoint p95 (run 5, equal priority): create version 217 ms · part URL 73 ms · acknowledge part 145 ms ·
**complete 191 ms** · status poll 186 ms. In run 3 `complete` was 1,130 ms.

### What the failed runs taught

- **Run 1: 3 failed `create` calls.** I did not capture their status codes and the API log was clean. The likely cause
  is Node closing idle keep-alive sockets after 5 s, so a client reusing one at that instant gets a reset. I raised
  `keepAliveTimeout` to 65 s (also a known cause of 502s behind proxies) and API failures dropped to 0 in every
  later run. That is consistent with the cause but not proof of it.
- **Run 3: `complete` was the bottleneck** (p95 1.13 s). It assembled the multipart object in storage inside the
  HTTP request. On real S3/R2 that step can take seconds for a 100 MB file, so a burst of them would hold request
  slots. Run 4 moves it into the worker: the API records the intent (a compare-and-set) and answers in
  milliseconds, and the worker assembles, size-checks, then validates the file. It is idempotent across retries
  and concurrent workers (a test caught that race).
- A separate 60-second burst-only profile (`top`, on the pre-fix code) showed the whole box at ~98% CPU for about
  30 s, so much of the earlier latency was queueing for CPU on the shared machine. The workload was never reduced to
  improve the numbers; every run used the same 2,000 teams and 1.5 MB files.

## A 100 MB-class file, for real

The load test uses 1.5 MB files so 2,000 of them fit on one small VM. Large files were verified separately
([`big-upload.ts`](../server/src/scripts/big-upload.ts)): a **99 MB zip, 13 parts of 8 MB**, interrupted after 5
parts and **resumed** (5 stored, 8 missing, only the 8 sent), then accepted by the worker. The `complete` call
took 8 ms, and the **API process memory moved from 141 MB to 143 MB** during the upload, confirming file bytes
never pass through it.

## Caveats

- **One shared 2-core machine.** Real deployments split the API, workers and storage; this setup is harsher on the
  API than that, but it is not a multi-instance scale test.
- **The storage is a stand-in** (`s3rver`), in both the load test and CI, not live MinIO or R2. Real object
  stores enforce limits it does not (for example a 5 MiB minimum part size) and have network latency.
- **Free-tier hosting** will add cold starts and smaller memory; this report is from the local run, not the live URL.
- **Status polling** was used in the test because k6 has no SSE client; the browser uses SSE, which is lighter.
- Run 2 was not reconciled (its data was reset before the check). Runs 1, 3, 4 and 5 were.

## Reproduce

```bash
cd server && npx tsx src/scripts/seed.ts --teams 2000 --out ../loadtest
# start: API, 2+ workers, S3-compatible storage (see README)
k6 run --log-format raw --console-output=loadtest/results/ledger.log loadtest/submit.js
cd server && npx tsx src/scripts/reconcile.ts ../loadtest/results/ledger.log
```

Raw outputs for every run are in [`loadtest/results/`](../loadtest/results).
