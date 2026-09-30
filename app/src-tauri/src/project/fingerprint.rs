//! Canonical fingerprints for validated compilation plans.
//!
//! The byte format is deliberately hand-written. JSON and debug output do not
//! provide a stable binary contract, while this encoder tags and length-prefixes
//! every field which may otherwise be ambiguous.

use std::ffi::OsStr;

use super::{CompilationPlan, EntrypointOrigin, SourceId};

pub(crate) const FINGERPRINT_ENCODING_VERSION: u32 = 1;
pub(crate) const COMPILER_CACHE_EPOCH: u32 = 1;
pub(crate) const COMPILER_PROFILE: &str = "quipu-yara-x-portable-v1";
const DOMAIN: &[u8] = b"quipu-compiled-project";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct PlanFingerprint([u8; 32]);

impl PlanFingerprint {
    pub(crate) fn to_hex(self) -> String {
        self.0.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    pub(crate) fn parse_hex(text: &str) -> Option<Self> {
        if text.len() != 64
            || !text
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return None;
        }
        let mut bytes = [0u8; 32];
        for (index, pair) in text.as_bytes().chunks_exact(2).enumerate() {
            let pair = std::str::from_utf8(pair).ok()?;
            bytes[index] = u8::from_str_radix(pair, 16).ok()?;
        }
        Some(Self(bytes))
    }
}

impl std::fmt::Display for PlanFingerprint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.to_hex())
    }
}

impl CompilationPlan {
    pub(crate) fn fingerprint(&self) -> PlanFingerprint {
        fingerprint_with(
            self,
            FingerprintContext {
                encoding: FINGERPRINT_ENCODING_VERSION,
                epoch: COMPILER_CACHE_EPOCH,
                yara_x_version: yara_x::VERSION,
                compiler_profile: COMPILER_PROFILE,
            },
        )
    }
}

#[derive(Clone, Copy)]
struct FingerprintContext<'a> {
    encoding: u32,
    epoch: u32,
    yara_x_version: &'a str,
    compiler_profile: &'a str,
}

fn fingerprint_with(plan: &CompilationPlan, context: FingerprintContext<'_>) -> PlanFingerprint {
    let mut encoder = Encoder::new();
    encoder.bytes(1, DOMAIN);
    encoder.u32(2, context.encoding);
    encoder.u32(3, context.epoch);
    encoder.text(4, context.yara_x_version);
    encoder.text(5, context.compiler_profile);
    encoder.os(6, plan.root().as_os_str());
    encoder.u8(
        7,
        match plan.entrypoint_origin() {
            EntrypointOrigin::Declared => 1,
            EntrypointOrigin::Inferred => 2,
        },
    );
    encoder.u64(8, plan.entrypoints().len() as u64);
    for input in plan.entrypoints() {
        encoder.source_id(9, &input.id);
    }
    encoder.u64(10, plan.include_dirs().len() as u64);
    for directory in plan.include_dirs() {
        encoder.os(11, directory.as_os_str());
    }
    encoder.u64(12, plan.closure().len() as u64);
    for input in plan.closure() {
        encoder.source_id(13, &input.id);
        encoder.u64(14, input.evidence.bytes);
        encoder.bytes(15, &input.evidence.digest);
    }
    encoder.u64(16, plan.edges().len() as u64);
    for edge in plan.edges() {
        encoder.source_id(17, &edge.from);
        encoder.u64(18, edge.order as u64);
        encoder.text(19, &edge.raw);
        encoder.source_id(20, &edge.to);
    }
    PlanFingerprint(*encoder.finish().as_bytes())
}

struct Encoder(blake3::Hasher);

impl Encoder {
    fn new() -> Self {
        Self(blake3::Hasher::new())
    }

    fn field(&mut self, tag: u8, value: &[u8]) {
        self.0.update(&[tag]);
        self.0.update(&(value.len() as u64).to_le_bytes());
        self.0.update(value);
    }

    fn bytes(&mut self, tag: u8, value: &[u8]) {
        self.field(tag, value);
    }

    fn text(&mut self, tag: u8, value: &str) {
        self.field(tag, value.as_bytes());
    }

    fn u8(&mut self, tag: u8, value: u8) {
        self.field(tag, &[value]);
    }

    fn u32(&mut self, tag: u8, value: u32) {
        self.field(tag, &value.to_le_bytes());
    }

    fn u64(&mut self, tag: u8, value: u64) {
        self.field(tag, &value.to_le_bytes());
    }

    fn source_id(&mut self, tag: u8, id: &SourceId) {
        self.field(tag, &[]);
        self.u8(1, u8::from(id.external));
        self.text(2, &id.path);
    }

    fn os(&mut self, tag: u8, value: &OsStr) {
        self.field(tag, &os_bytes(value));
    }

    fn finish(self) -> blake3::Hash {
        self.0.finalize()
    }
}

#[cfg(unix)]
fn os_bytes(value: &OsStr) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;
    let mut bytes = vec![1];
    bytes.extend_from_slice(value.as_bytes());
    bytes
}

#[cfg(windows)]
fn os_bytes(value: &OsStr) -> Vec<u8> {
    use std::os::windows::ffi::OsStrExt;
    let mut bytes = vec![2];
    for unit in value.encode_wide() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    bytes
}

#[cfg(not(any(unix, windows)))]
fn os_bytes(value: &OsStr) -> Vec<u8> {
    let mut bytes = vec![3];
    bytes.extend_from_slice(value.as_encoded_bytes());
    bytes
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::project::{PlanInput, SourceEvidence, plan::PlanEdge};

    fn id(path: &str) -> SourceId {
        SourceId {
            external: false,
            path: path.to_string(),
        }
    }

    fn input(path: &str, byte: u8) -> PlanInput {
        PlanInput {
            id: id(path),
            canonical: PathBuf::from("/project").join(path),
            evidence: SourceEvidence {
                bytes: 1,
                digest: [byte; 32],
            },
        }
    }

    fn plan() -> CompilationPlan {
        let a = input("a.yar", 1);
        let b = input("b.yar", 2);
        let c = input("c.yar", 3);
        CompilationPlan {
            root: PathBuf::from("/project"),
            origin: EntrypointOrigin::Declared,
            entrypoints: vec![a.clone()],
            include_dirs: vec![PathBuf::from("/project")],
            closure: vec![a, b, c],
            edges: vec![PlanEdge {
                from: id("a.yar"),
                order: 0,
                raw: "common.yar".into(),
                to: id("b.yar"),
            }],
        }
    }

    #[test]
    fn fingerprint_is_stable_and_lowercase_hex() {
        let first = plan().fingerprint();
        let second = plan().fingerprint();
        assert_eq!(first, second);
        let text = first.to_hex();
        assert_eq!(text.len(), 64);
        assert_eq!(PlanFingerprint::parse_hex(&text), Some(first));
        assert!(PlanFingerprint::parse_hex(&text.to_uppercase()).is_none());
    }

    #[test]
    fn every_compilation_dimension_changes_the_fingerprint() {
        let base = plan();
        let expected = base.fingerprint();
        let mut changed = plan();
        changed.root = PathBuf::from("/elsewhere");
        assert_ne!(changed.fingerprint(), expected);
        let mut changed = plan();
        changed.origin = EntrypointOrigin::Inferred;
        assert_ne!(changed.fingerprint(), expected);
        let mut changed = plan();
        changed.entrypoints.push(input("b.yar", 2));
        assert_ne!(changed.fingerprint(), expected);
        let mut changed = plan();
        changed.include_dirs.push(PathBuf::from("/other"));
        assert_ne!(changed.fingerprint(), expected);
        let mut changed = plan();
        changed.closure[0].evidence.bytes += 1;
        assert_ne!(changed.fingerprint(), expected);
        let mut changed = plan();
        changed.closure[0].evidence.digest[0] ^= 1;
        assert_ne!(changed.fingerprint(), expected);
    }

    #[test]
    fn a_resolved_edge_target_changes_the_key_with_identical_sources_and_closure() {
        let first = plan();
        let mut second = plan();
        // This is the cache-relevant observation which source records alone
        // cannot express: raw bytes and closure membership are identical, while
        // the same include spelling now selects the other already-present node.
        second.edges[0].to = id("c.yar");
        assert_eq!(first.closure, second.closure);
        assert_eq!(first.edges[0].raw, second.edges[0].raw);
        assert_ne!(first.fingerprint(), second.fingerprint());
    }

    #[test]
    fn compatibility_fields_are_part_of_the_key() {
        let plan = plan();
        let context = FingerprintContext {
            encoding: FINGERPRINT_ENCODING_VERSION,
            epoch: COMPILER_CACHE_EPOCH,
            yara_x_version: yara_x::VERSION,
            compiler_profile: COMPILER_PROFILE,
        };
        let expected = fingerprint_with(&plan, context);
        assert_ne!(
            fingerprint_with(
                &plan,
                FingerprintContext {
                    encoding: 2,
                    ..context
                }
            ),
            expected
        );
        assert_ne!(
            fingerprint_with(
                &plan,
                FingerprintContext {
                    epoch: 2,
                    ..context
                }
            ),
            expected
        );
        assert_ne!(
            fingerprint_with(
                &plan,
                FingerprintContext {
                    yara_x_version: "other",
                    ..context
                }
            ),
            expected
        );
        assert_ne!(
            fingerprint_with(
                &plan,
                FingerprintContext {
                    compiler_profile: "other",
                    ..context
                }
            ),
            expected
        );
    }
}
