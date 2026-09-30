//! Tests for the analysis wire shapes.
//!
//! These assert on the serialized JSON rather than on the Rust DTOs, because the
//! JSON *is* the contract: a renamed field or a flattened identity is a breaking
//! change for `app/src/ipc.ts` even though the Rust types still compile.

use std::path::Path;

use serde_json::{Value, json};

use crate::testing::{Fixture, rule};

use super::*;

fn wire(root: &Path) -> Value {
    let analysis = describe(&crate::project::open_project(root));
    serde_json::to_value(analysis).expect("the analysis serializes")
}

/// The `path` values of a JSON array of identities.
fn paths(value: &Value) -> Vec<&str> {
    value
        .as_array()
        .expect("an array")
        .iter()
        .map(|item| item["path"].as_str().expect("a path"))
        .collect()
}

#[test]
fn a_valid_snapshot_serializes_as_identities() {
    let fixture = Fixture::new();
    fixture.manifest("schema = 1\nentrypoints = [\"main.yar\"]\n");
    fixture.write("main.yar", "include \"lib.yar\"\n");
    fixture.write("lib.yar", &rule("lib"));

    // Asserted whole rather than field by field: an added field is as much a wire
    // change as a renamed one, and this is where it should be noticed.
    assert_eq!(
        wire(&fixture.root),
        json!({
            "status": "loaded",
            "root": fixture.root_text(),
            "manifest": "quipu.toml",
            "entrypointOrigin": "declared",
            "entrypoints": [{"external": false, "path": "main.yar"}],
            "discovered": [
                {"external": false, "path": "lib.yar"},
                {"external": false, "path": "main.yar"},
            ],
            "nodes": [
                {"id": {"external": false, "path": "lib.yar"}, "readable": true},
                {"id": {"external": false, "path": "main.yar"}, "readable": true},
            ],
            "edges": [{
                "from": {"external": false, "path": "main.yar"},
                "order": 0,
                "raw": "lib.yar",
                "span": {"start": 0, "end": 17},
                "to": {"external": false, "path": "lib.yar"},
            }],
            "issues": [],
            "compilable": true,
        })
    );
}

#[test]
fn a_configuration_failure_is_a_result_carrying_its_own_code() {
    let fixture = Fixture::new();
    fixture.manifest("schema = 2\n");

    let wire = wire(&fixture.root);

    assert_eq!(wire["status"], "configurationFailed");
    let issue = &wire["issue"];
    // The specific code, not a generic `invalid-configuration`: a UI that has to
    // tell the user what to fix needs to know which failure this is.
    assert_eq!(issue["code"], "manifest-unsupported-schema");
    assert_eq!(issue["severity"], "blocking");
    assert_eq!(issue["scope"], "project");
    assert_eq!(issue["at"], Value::Null);
    assert_eq!(issue["span"], Value::Null);
    assert!(
        issue["message"]
            .as_str()
            .expect("a message")
            .contains("schema 2"),
        "{}",
        issue["message"]
    );
    // No snapshot exists, so none of the loaded fields are there to be misread as
    // an empty project.
    assert_eq!(wire.get("root"), None);
    assert_eq!(wire.get("compilable"), None);
}

#[test]
fn a_snapshot_can_load_and_still_not_be_compilable() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "include \"nowhere.yar\"\n");

    let wire = wire(&fixture.root);

    assert_eq!(wire["status"], "loaded");
    assert_eq!(wire["compilable"], false);
    // An unresolved include stays on the wire with its position: a broken graph is
    // exactly what the Includes view has to be able to render.
    assert_eq!(
        wire["edges"],
        json!([{
            "from": {"external": false, "path": "main.yar"},
            "order": 0,
            "raw": "nowhere.yar",
            "span": {"start": 0, "end": 21},
            "to": Value::Null,
        }])
    );
    assert_eq!(
        wire["issues"][0]["at"],
        json!({"external": false, "path": "main.yar"})
    );
    assert_eq!(wire["issues"][0]["code"], "missing-include");
    assert_eq!(wire["issues"][0]["severity"], "blocking");
    assert_eq!(wire["issues"][0]["scope"], "source");
    assert_eq!(wire["issues"][0]["span"], json!({"start": 0, "end": 21}));
}

#[test]
fn an_external_dependency_is_informational_and_keeps_an_absolute_identity() {
    let fixture = Fixture::new();
    fixture.write("main.yar", "include \"../shared/ext.yar\"\n");
    fixture.write_outside("shared/ext.yar", &rule("ext"));

    let wire = wire(&fixture.root);

    assert_eq!(wire["status"], "loaded");
    assert_eq!(wire["manifest"], Value::Null);
    assert_eq!(wire["entrypointOrigin"], "inferred");
    // Informational, so the project still compiles.
    assert_eq!(wire["compilable"], true);

    let issue = &wire["issues"][0];
    assert_eq!(issue["code"], "external-dependency");
    assert_eq!(issue["severity"], "informational");
    assert_eq!(issue["scope"], "source");
    assert_eq!(issue["span"], Value::Null);

    // `external` is what makes `path` an absolute path rather than a
    // root-relative one, which is why the two are never flattened into one
    // string.
    assert_eq!(issue["at"]["external"], true);
    let path = issue["at"]["path"].as_str().expect("a path");
    assert!(path.ends_with("shared/ext.yar"), "{path}");
    assert!(
        path != "../shared/ext.yar",
        "an identity is never a spelling"
    );

    // Nodes are ordered by identity, which puts every internal source first.
    assert_eq!(wire["nodes"][0]["id"]["external"], false);
    assert_eq!(wire["nodes"][1]["id"]["external"], true);
}

#[test]
fn a_project_with_nothing_in_it_analyzes_to_an_empty_but_compilable_snapshot() {
    let fixture = Fixture::new();

    let wire = wire(&fixture.root);

    assert_eq!(wire["status"], "loaded");
    assert_eq!(wire["entrypoints"], json!([]));
    assert_eq!(wire["discovered"], json!([]));
    assert_eq!(wire["nodes"], json!([]));
    assert_eq!(wire["edges"], json!([]));
    assert_eq!(wire["issues"], json!([]));
    assert_eq!(wire["compilable"], true);
}

#[test]
fn repeated_analyses_serialize_identically_and_in_identity_order() {
    let fixture = Fixture::new();
    fixture.manifest("schema = 1\ninclude_dirs = [\".\", \"shared\"]\n");
    fixture.write("z.yar", "include \"common.yar\"\ninclude \"missing.yar\"\n");
    fixture.write("a.yar", "include \"nested/deep.yar\"\n");
    fixture.write("nested/deep.yar", "include \"common.yar\"\n");
    fixture.write("shared/common.yar", &rule("common"));
    fixture.write("m.yar", "rule unfinished { \n");
    fixture.write("e.yar", "include \"../outside/ext.yar\"\n");
    fixture.write_outside("outside/ext.yar", &rule("ext"));

    let first = wire(&fixture.root);

    assert_eq!(first, wire(&fixture.root));

    // Discovery order is the model's identity order, not the filesystem's.
    let discovered = paths(&first["discovered"]);
    let mut sorted = discovered.clone();
    sorted.sort_unstable();
    assert_eq!(discovered, sorted);

    // Edges are ordered by `(from, order)`, independent of traversal order.
    let ordered: Vec<(&str, u64)> = first["edges"]
        .as_array()
        .expect("an array")
        .iter()
        .map(|edge| {
            (
                edge["from"]["path"].as_str().expect("a path"),
                edge["order"].as_u64().expect("an order"),
            )
        })
        .collect();
    let mut sorted_edges = ordered.clone();
    sorted_edges.sort_unstable();
    assert_eq!(ordered, sorted_edges);

    // Issues carry stable codes rather than positions in a list, so a UI can
    // branch on them.
    let codes: Vec<&str> = first["issues"]
        .as_array()
        .expect("an array")
        .iter()
        .map(|issue| issue["code"].as_str().expect("a code"))
        .collect();
    assert!(codes.contains(&"missing-include"), "{codes:?}");
    assert!(codes.contains(&"parser-error"), "{codes:?}");
    assert!(codes.contains(&"external-dependency"), "{codes:?}");
    assert_eq!(first["compilable"], false);
}
