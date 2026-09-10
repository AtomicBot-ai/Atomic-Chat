//! Symbol index over a workspace, for agent code navigation.
//!
//! Answers "where is this defined" and "where is this mentioned" without the
//! agent grepping the tree blind. Deliberately much smaller than a full code
//! graph: definitions plus syntax-aware occurrence search, no name resolution.

mod index;
mod parser;
mod references;

pub use index::{CodeIndex, IndexLimits, MatchMode, RefreshStats, SymbolHit};
pub use parser::{identifier_occurrences, symbols_in_source, Language, Symbol, SymbolKind};
pub use references::{find_references, Reference, ReferenceScan};
