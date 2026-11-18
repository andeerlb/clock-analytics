//! Who last saved a spreadsheet, and when, read from the file's own
//! properties: `docProps/core.xml` in an .xlsx (`cp:lastModifiedBy`,
//! `dcterms:modified`) and `meta.xml` in an .ods (`dc:creator`, `dc:date`).
//! Excel (desktop or Online) and LibreOffice write these on every save.
//! Formats without such properties (.xls, .csv) report nothing.

use serde::Serialize;
use std::fs::File;
use std::io::Read;

#[derive(Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileAuthor {
    /// `None` when the file has the property but no name in it (saved by a
    /// program that writes none), or when there's no property at all.
    pub saved_by: Option<String>,
    /// When it was saved, as written in the file (ISO 8601). `None` when
    /// the format carries no such property: then nothing is known.
    pub saved_at: Option<String>,
}

pub fn read(path: &str) -> FileAuthor {
    let Ok(file) = File::open(path) else {
        return FileAuthor::default();
    };
    let Ok(mut archive) = zip::ZipArchive::new(file) else {
        return FileAuthor::default(); // not a zip: .xls, .csv
    };
    if let Some(xml) = read_entry(&mut archive, "docProps/core.xml") {
        return FileAuthor {
            saved_by: tag_text(&xml, "lastModifiedBy").filter(|s| !s.is_empty()),
            saved_at: tag_text(&xml, "modified").filter(|s| !s.is_empty()),
        };
    }
    if let Some(xml) = read_entry(&mut archive, "meta.xml") {
        return FileAuthor {
            saved_by: tag_text(&xml, "creator").filter(|s| !s.is_empty()),
            saved_at: tag_text(&xml, "date").filter(|s| !s.is_empty()),
        };
    }
    FileAuthor::default()
}

fn read_entry(archive: &mut zip::ZipArchive<File>, name: &str) -> Option<String> {
    let mut entry = archive.by_name(name).ok()?;
    let mut text = String::new();
    entry.read_to_string(&mut text).ok()?;
    Some(text)
}

/// Text of the first element whose local name is `local` (any namespace
/// prefix, any attributes), with the five XML entities decoded. A tiny
/// reader for these two flat property files, not a general XML parser.
fn tag_text(xml: &str, local: &str) -> Option<String> {
    let mut rest = xml;
    while let Some(lt) = rest.find('<') {
        rest = &rest[lt + 1..];
        let end = rest.find('>')?;
        let tag = &rest[..end];
        if tag.starts_with('/') || tag.starts_with('?') || tag.starts_with('!') {
            continue;
        }
        let name = tag.split(|c: char| c.is_whitespace() || c == '/').next().unwrap_or("");
        let local_name = name.rsplit(':').next().unwrap_or(name);
        if local_name != local {
            continue;
        }
        if tag.ends_with('/') {
            return Some(String::new());
        }
        let body = &rest[end + 1..];
        let close = body.find(&format!("</{name}>"))?;
        return Some(decode(body[..close].trim()));
    }
    None
}

fn decode(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn zip_with(entries: &[(&str, &str)]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("file_author_{}_{}.zip", std::process::id(), entries.len() + entries.first().map_or(0, |e| e.1.len())));
        let mut zip = zip::ZipWriter::new(File::create(&path).unwrap());
        for (name, body) in entries {
            zip.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        path
    }

    #[test]
    fn reads_xlsx_core_properties() {
        let core = r#"<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="x" xmlns:dc="y" xmlns:dcterms="z"><dc:creator>Ana</dc:creator><cp:lastModifiedBy>Maria Souza &amp; Cia</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">2026-01-01T00:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2026-11-16T14:28:00Z</dcterms:modified></cp:coreProperties>"#;
        let path = zip_with(&[("docProps/core.xml", core), ("xl/workbook.xml", "<w/>")]);
        let author = read(path.to_str().unwrap());
        assert_eq!(author.saved_by.as_deref(), Some("Maria Souza & Cia"));
        assert_eq!(author.saved_at.as_deref(), Some("2026-11-16T14:28:00Z"));
    }

    #[test]
    fn empty_name_is_none_but_date_is_kept() {
        let core = r#"<cp:coreProperties><cp:lastModifiedBy></cp:lastModifiedBy><dcterms:modified>2026-11-16T10:00:00Z</dcterms:modified></cp:coreProperties>"#;
        let path = zip_with(&[("docProps/core.xml", core)]);
        let author = read(path.to_str().unwrap());
        assert_eq!(author.saved_by, None);
        assert_eq!(author.saved_at.as_deref(), Some("2026-11-16T10:00:00Z"));
    }

    #[test]
    fn reads_ods_meta() {
        let meta = r#"<office:document-meta><office:meta><meta:initial-creator>Ana</meta:initial-creator><dc:creator>Carlos Mendes</dc:creator><dc:date>2026-11-16T11:05:00.123</dc:date></office:meta></office:document-meta>"#;
        let path = zip_with(&[("meta.xml", meta), ("content.xml", "<c/>")]);
        let author = read(path.to_str().unwrap());
        assert_eq!(author.saved_by.as_deref(), Some("Carlos Mendes"));
        assert_eq!(author.saved_at.as_deref(), Some("2026-11-16T11:05:00.123"));
    }

    #[test]
    fn not_a_zip_reports_nothing() {
        let path = std::env::temp_dir().join(format!("file_author_{}.csv", std::process::id()));
        std::fs::write(&path, "a;b\n1;2\n").unwrap();
        assert_eq!(read(path.to_str().unwrap()), FileAuthor::default());
    }
}
