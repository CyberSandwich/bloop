# Graph fixtures

These JSON files are **synthetic**. They were written by hand from the shapes in Microsoft's documentation, not recorded from a real tenant, and every id, name, host and URL in them is made up.

They back `test/unit/graph-source.test.ts`, which proves `GraphFileSource` builds the requests the documentation describes and maps each answer to a `SourceError`.

| File | Shape it follows |
| --- | --- |
| `children.json` | [List children of a driveItem](https://learn.microsoft.com/graph/api/driveitem-list-children): a mix of decks, a macro deck, a Word file and a folder, deliberately out of date order. |
| `item-pptx.json`, `item-pdf.json` | [Get a driveItem](https://learn.microsoft.com/graph/api/driveitem-get), with the `@microsoft.graph.downloadUrl` instance annotation. |
| `item-foreign-host.json` | The same shape with a download URL on a host outside `GRAPH_DOWNLOAD_HOSTS`. |
| `item-pptm.json`, `item-folder.json` | Items bloop must refuse. |
| `error-*.json` | The [error response](https://learn.microsoft.com/graph/errors) body: `{"error": {"code", "message"}}`. |

The Graph calls are unverified against a live tenant until field check F-ENTRA (docs/threat-model.md). A fixture here passing says nothing about what Microsoft returns today; replace these with recorded responses from the demo tenant then.
