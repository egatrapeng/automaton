# Context tokenization: validation and limits

The token counter previously passed arbitrarily long strings into synchronous
`js-tiktoken` byte-pair encoding. Repetitive 50,000- and 500,000-character inputs
in `context-hardening.test.ts` could block the worker and prevent the test suite
from completing. A test timeout cannot interrupt a synchronous CPU-bound call.

The counter now uses exact cl100k encoding only for inputs up to 4,096 UTF-8
bytes. Longer input and encoder failures return the UTF-8 byte count, a
conservative upper bound for this byte-level BPE. It does not truncate or discard
the original text. Context selection may compress history earlier because this
bound overestimates tokens. The existing protected recent-turn and system-prompt
behavior is unchanged; this change does not claim a hard cap on the entire
serialized inference request, especially its mandatory messages.

The encoder is initialized once per process, lazily. The LRU cache uses
unambiguous tuple keys, at most 10,000 entries, and at most 2 MiB of approximate
UTF-16 key storage (Map bookkeeping and the encoder are additional). Long inputs
and unusually long model identifiers are not retained. These bounds prevent
large external text from being retained 10,000 times in cache keys.

## Reproduce

From the repository root with Node 22 and dependencies installed:

```sh
node --import tsx scripts/benchmark-context.ts
pnpm test src/__tests__/context-hardening.test.ts src/__tests__/memory/context-manager.test.ts --maxWorkers=2 --minWorkers=1
```

The benchmark executes the previous raw encoder in a separate process with a
2.5-second limit. It reports a timeout explicitly rather than treating it as a
completed run. The current scenarios execute 100 iterations and report p50/p95.

## Observed run, 3 November 2026

Node 22.23.4; container CPU quota 4 cores (`400000 100000`), memory limit 32 GiB.
This is a synthetic local measurement, not a 2-vCPU/4-GiB VPS benchmark, service
latency measurement, or an assertion of production throughput.

| Scenario | Previous raw BPE | Current p50 / p95 |
| --- | --- | --- |
| 50,000 repeated ASCII characters | Did not complete within 2.5 s | 0.012 / 0.015 ms |
| 500,000 repeated ASCII characters | Not rerun unbounded | 0.176 / 0.264 ms |
| Short independent task messages | Not separately measured | 0.015 / 0.039 ms |
| Long Unicode input | Not separately measured | 0.032 / 0.057 ms |

Encoder initialization took 242 ms. Benchmark process RSS was about 211 MiB
(including the TypeScript loader and encoder); this is not the application's
idle RSS. The test run completed **59 tests in two files**, 0.90 seconds overall.
No assertions were removed, no tests were skipped, and no encoding verification
was disabled. Special-token-shaped data is encoded as ordinary text.

Measure inference, SQLite, tool execution, and full runtime memory separately
before claiming the complete agent meets a VPS performance target.
