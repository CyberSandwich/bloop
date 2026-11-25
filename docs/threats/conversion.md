# Threats: conversion

Rows start `planned` and flip to `mitigated` when their test lands; same columns and status words as [threat-model.md](../threat-model.md). Owner stream: V (conversion).

| id | STRIDE | threat | L | I | mitigation | test | status |
|---|---|---|---|---|---|---|---|
| CONV-01 | E | Remote code execution in the converter through a hostile file | med | high | Each job runs in a disposable container: no network, non-root, read-only root filesystem, one job per container | `CONV-01 isolation` | planned |
| CONV-02 | D | A file exhausts CPU, memory, disk or time | high | med | Caps and timeouts at every stage; the container is destroyed on the deadline on every path | `CONV-02 caps` | planned |
| CONV-03 | E | A macro or auto-open action runs during conversion | med | high | Macro security at maximum; a fixture that tries to write a file on open leaves no side effect | `CONV-03 macros` | planned |
| CONV-04 | T | An unchecked output reaches storage or a viewer | med | high | Every output is validated by type, size and structure before it goes into R2 | `CONV-04 outputs` | planned |
| CONV-05 | I | A job runs outside the EU | low | med | The Converter object and its container are created in the `eu` jurisdiction; placement is read back in a live check | `CONV-05 eu` | planned |
| CONV-06 | T | A stale image carries known flaws | med | med | A monthly rebuild and a digest pin | `CONV-06 pin` | planned |
| CONV-07 | I | One job's data leaks into the next | low | high | A fresh container per job; nothing persists between jobs | `CONV-07 fresh` | planned |
