export const DESCRIPTION = `Query/manage infermem knowledge trees (corpus). Each corpus = one ingest (one book, or several books read together) — independent by default.

Actions:
- status — list all corpora (knowledge trees) with atom/edge counts.
- query(term, corpusId?) — find atoms by name / alias / keyword within a corpus (default: most recent).
- read(atomId, corpusId?) — full atom content + prerequisites/downstream.
- walk(atomId, direction?, corpusId?) — transitive dependency cone (up=prerequisites, down=downstream).
- merge(source, corpusId) — EXPLICITLY merge corpus source into corpus corpusId (semantic entity resolution across the two).`;
