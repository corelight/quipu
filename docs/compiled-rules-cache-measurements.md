# Compiled-rules cache measurements

Measured 2026-09-11 on Linux 6.17.0-1010-oem x86_64, an Intel Core Ultra 7
268V with 32 GB RAM, rustc/cargo 1.95.0, and YARA-X 1.19.0. These are development
profile measurements from an otherwise interactive workstation, not release
benchmarks or pass/fail thresholds.

Method: the ignored Rust test
`cache::tests::measure_portable_cache_operations` generated one 15,530-byte source
containing 250 distinct string rules. It warmed compilation once, then took the
median of 11 in-process observations for each operation. Fresh compilation reused
the already-derived `CompilationPlan`; cache restoration included cache locks,
bounded metadata/artifact reads, BLAKE3 validation and `Rules::deserialize`.

| Measurement | Result |
| --- | ---: |
| Portable artifact | 20,292 bytes |
| Metadata | 894 bytes |
| Fresh compilation | 141,574 us median |
| Serialization | 444 us median |
| Direct deserialization | 108,298 us median |
| Full cache restoration | 109,127 us median |

The initial 1 GiB/80% quota remains deliberately provisional, but this sample does
not justify reducing it before measuring larger real-world rule collections. The
portable artifact is small here; restoration time is dominated by YARA-X portable
deserialization rather than disk I/O or serialization. Native-code serialization
therefore remains a separate future measurement/design decision as contracted.

## Real-project metadata verification

Measured 2026-09-12 with Quipu's actual project compile/prepare/commit/load pipeline
against the reported Polaris rules project and a fixture-owned isolated cache/config
root. The first operation returned `Committed`; the unchanged second operation was a
`Hit`. Both carried exactly 19,809 rules and 4,344 diagnostics. The fixture removed
the isolated cache after the check and the source project was read only.

| Measurement | Result |
| --- | ---: |
| Portable artifact | 29,034,140 bytes |
| Compact metadata | 1,036,225 bytes |
| Rules | 19,809 |
| Diagnostics | 4,344 |

The earlier pretty-printed metadata was 1,557,906 bytes. Compact streaming therefore
removed 521,681 bytes (33.5%) and brought this particular project just below 1 MiB,
but that coincidence is not a safe policy: modest diagnostic growth would recreate
the failure. The independent 16 MiB ceiling is 16.2 times this compact real-project
measurement while keeping metadata read/allocation/parser exposure far below the
256 MiB artifact ceiling.
