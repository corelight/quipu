//! Extracting `include` directives with YARA-X's own parser.
//!
//! The include graph has to agree with what the compiler will actually do, so
//! this uses `yara_x_parser`'s public AST rather than scanning lines. The
//! parser also recovers from errors: a file with a broken rule still yields the
//! `include` statements it declares, which keeps a partially broken project
//! navigable.
//!
//! Errors are read from the AST's typed `Error` enum. Nothing here parses
//! Debug output.

use yara_x_parser::ast::{AST, Error, Item, WithSpan};

use super::issues::ByteSpan;

/// One `include` directive, as written.
pub(crate) struct ParsedInclude {
    /// The filename exactly as it appears in the source, without quotes. It is
    /// passed to include resolution verbatim, the way YARA-X does.
    pub file_name: String,
    /// Byte span of the whole `include "..."` statement.
    pub span: ByteSpan,
}

/// The parse result for one source file.
pub(crate) struct ParsedSource {
    /// Include directives in source order.
    pub includes: Vec<ParsedInclude>,
    /// Parser errors, in the order the parser reported them.
    pub errors: Vec<(String, ByteSpan)>,
}

/// Parses `bytes` and extracts its include directives and parser errors.
///
/// Takes raw bytes rather than a `str` so a file that is not valid UTF-8 is
/// reported as a parser error (which is how YARA-X sees it) instead of as an
/// unreadable file.
pub(crate) fn parse_source(bytes: &[u8]) -> ParsedSource {
    let ast = AST::from(bytes);

    let includes = ast
        .items()
        .filter_map(|item| match item {
            Item::Include(include) => Some(ParsedInclude {
                file_name: include.file_name.to_string(),
                span: include.span().into(),
            }),
            Item::Import(_) | Item::Rule(_) => None,
        })
        .collect();

    let errors = ast.errors().iter().map(describe_error).collect();

    ParsedSource { includes, errors }
}

/// Maps a parser error onto a message and a span.
///
/// Matched exhaustively on purpose: if a YARA-X upgrade adds a variant, this
/// stops compiling instead of silently degrading the diagnostic.
fn describe_error(error: &Error) -> (String, ByteSpan) {
    match error {
        Error::SyntaxError { message, span }
        | Error::InvalidInteger { message, span }
        | Error::InvalidFloat { message, span }
        | Error::InvalidRegexpModifier { message, span }
        | Error::InvalidEscapeSequence { message, span } => (message.clone(), span.clone().into()),
        Error::InvalidUTF8(span) => ("invalid UTF-8".to_string(), span.clone().into()),
        Error::UnexpectedEscapeSequence(span) => (
            "unexpected escape sequence".to_string(),
            span.clone().into(),
        ),
    }
}
