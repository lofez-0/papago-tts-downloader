//! 불러온 텍스트 파일(txt, csv, tsv) 읽기.
//! 한국어 Windows의 엑셀은 CSV를 CP949로 저장하는 경우가 많아서 UTF-8이 아니면 CP949로 읽는다.

use std::path::Path;

pub const MAX_BYTES: u64 = 5 * 1024 * 1024;
pub const EXTENSIONS: [&str; 3] = ["txt", "csv", "tsv"];

pub fn decode(bytes: &[u8]) -> String {
    if let Some((encoding, bom_len)) = encoding_rs::Encoding::for_bom(bytes) {
        return encoding.decode_without_bom_handling(&bytes[bom_len..]).0.into_owned();
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_owned(),
        // encoding_rs의 EUC_KR은 CP949(확장 완성형)까지 포함한다
        Err(_) => encoding_rs::EUC_KR.decode_without_bom_handling(bytes).0.into_owned(),
    }
}

pub fn read(path: &Path) -> Result<String, String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !EXTENSIONS.contains(&ext.as_str()) {
        return Err("txt, csv, tsv 파일만 불러올 수 있습니다.".into());
    }
    let meta = std::fs::metadata(path).map_err(|e| format!("파일을 열 수 없습니다: {e}"))?;
    if meta.len() > MAX_BYTES {
        return Err("5MB보다 큰 파일은 불러올 수 없습니다.".into());
    }
    let bytes = std::fs::read(path).map_err(|e| format!("파일을 읽을 수 없습니다: {e}"))?;
    Ok(decode(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_utf8_with_and_without_bom() {
        assert_eq!(decode("안녕,hello".as_bytes()), "안녕,hello");
        let mut bom = vec![0xef, 0xbb, 0xbf];
        bom.extend_from_slice("안녕".as_bytes());
        assert_eq!(decode(&bom), "안녕");
    }

    #[test]
    fn decodes_utf16_with_bom() {
        let mut v = vec![0xff, 0xfe];
        for u in "안녕".encode_utf16() {
            v.extend_from_slice(&u.to_le_bytes());
        }
        assert_eq!(decode(&v), "안녕");
    }

    #[test]
    fn decodes_cp949() {
        // "안녕,똠방각하" (똠은 CP949 확장 글자)
        let (bytes, _, _) = encoding_rs::EUC_KR.encode("안녕,똠방각하");
        assert_eq!(decode(&bytes), "안녕,똠방각하");
    }

    #[test]
    fn rejects_other_extensions() {
        assert!(read(Path::new("a.mp3")).is_err());
    }
}
