# Threats: conversion

Rows start `planned` and flip to `mitigated` when their test lands; same columns and status words as [threat-model.md](../threat-model.md). Owner stream: V (conversion). The behavior is in [conversion.md](../conversion.md), the decision in [ADR 0019](../adr/0019-converter.md).

| id | STRIDE | threat | L | I | mitigation | test | status |
|---|---|---|---|---|---|---|---|
| CONV-01 | E | Remote code execution in the converter through a hostile file | med | high | Each job runs in a disposable container: no network, non-root, read-only root filesystem, one job per container | `CONV-01 isolation` | planned |
| CONV-02 | D | A file exhausts CPU, memory, disk or time | high | med | Caps and timeouts at every stage; a deadline checked on every alarm; the container is destroyed and the lease released on every path | `CONV-02 caps` | mitigated |
| CONV-03 | E | A macro or auto-open action runs during conversion | med | high | Macro security at maximum; a fixture that tries to write a file on open leaves no side effect | `CONV-03 macros` | planned |
| CONV-04 | T | An unchecked output reaches storage or a viewer | med | high | Every output is checked again after the container: an anchored path grammar, the exact expected set, size and hash as it streams, head and tail by type, the JSON by schema; the viewer's `slides.json` is built from checked values | `CONV-04 outputs` | mitigated |
| CONV-05 | I | A job runs outside the EU | low | med | The Converter object and its container are created in the `eu` jurisdiction; placement is read back in a live check | `CONV-05 eu` | planned |
| CONV-06 | T | A stale image carries known flaws | med | med | A monthly rebuild and a digest pin | `CONV-06 pin` | planned |
| CONV-07 | I | One job's data leaks into the next | low | high | A fresh container per attempt, with a new job id; a stale run id is refused | `CONV-07 fresh` | mitigated |
| CONV-08 | D | Cost amplification through re-convert | med | med | One run per version, at most 2 container starts across every claim, final codes are never started again, a per-day take | `CONV-08 claim` | mitigated |
| CONV-09 | D | A job hangs with no honest status | med | med | The deadline on every alarm, a count of unknown throws, a sweep that asks each stale run's Converter, terminal pushes | `CONV-09 sweep` | mitigated |
| CONV-10 | T | Output smuggling into the bundle or across prefixes | med | high | The grammar, the exact expected set, a prefix read from D1, notes only under `n/`, a Converter-built `slides.json` | `CONV-10 smuggling` | mitigated |
| CONV-11 | D | Queue exhaustion and alarm storms | med | med | Queue caps at request time, a lease wait that is bounded, jittered and gives up at 30 minutes, one alarm per object | `CONV-11 queue` | mitigated |
| CONV-12 | T | Work continues after delete or disable | med | med | Cancel ends the run; every store unit re-checks the file and its owner; a put in flight deletes its own key; the publish is guarded by the servable file | `CONV-12 cancel` | mitigated |
| CONV-13 | R | Progress lies | low | low | Frames come from a validated status, only rise, and `pageReady` follows the store of page 1 | `CONV-13 progress` | mitigated |
