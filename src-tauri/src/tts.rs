//! 파파고 웹이 내부에서 쓰는 TTS 엔드포인트 호출.
//!
//! 1. POST /api/tts/makeID (폼: alpha, pitch, speaker, speed, text) -> {"id": "..."}
//! 2. GET  /api/tts/{id} -> audio/mpeg
//!
//! 비공식 엔드포인트라 파파고가 사이트를 바꾸면 예고 없이 동작하지 않을 수 있다.

use std::time::Duration;

use reqwest::{header, Client};
use serde::Deserialize;

const API: &str = "https://papago.naver.com/api/tts";

/// 파파고 웹이 한 번에 읽어 주는 최대 글자 수 (웹 코드의 TTS_MAX_TEXT_LENGTH).
/// 이보다 긴 글은 문장 단위로 나눠 받은 뒤 하나의 mp3로 이어 붙인다.
pub const MAX_CHUNK_CHARS: usize = 1000;

/// 한 번에 저장할 수 있는 최대 글자 수 (요청 폭주 방지).
pub const MAX_TOTAL_CHARS: usize = 20_000;

pub fn build_client() -> reqwest::Result<Client> {
    let mut headers = header::HeaderMap::new();
    headers.insert(
        header::REFERER,
        header::HeaderValue::from_static("https://papago.naver.com/"),
    );
    Client::builder()
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
        )
        .default_headers(headers)
        .timeout(Duration::from_secs(30))
        .build()
}

/// 언어와 성별로 파파고 화자 이름을 고른다 (웹 코드의 findSpeaker와 같은 표).
pub fn speaker(language: &str, gender: &str) -> Option<&'static str> {
    let (male, female) = match language {
        "ko" => ("jinho", "kyuri"),
        "en" => ("matt", "clara"),
        "ja" => ("shinji", "yuri"),
        "zh-CN" => ("liangliang", "meimei"),
        "zh-TW" => ("kuanlin", "chiahua"),
        "es" => ("jose", "carmen"),
        "fr" => ("louis", "roxane"),
        "de" => ("tim", "lena"),
        "ru" => ("aleksei", "vera"),
        "th" => ("sarawut", "somsi"),
        _ => return None,
    };
    Some(if gender == "female" { female } else { male })
}

/// 속도 값: 5 아주 느리게, 3 느리게, 0 보통, -2 빠르게.
/// 웹과 같이 영어·프랑스어는 "빠르게"를 -1로 낮춘다.
fn normalize_speed(speed: i32, language: &str) -> Result<i32, String> {
    match speed {
        5 | 3 | 0 => Ok(speed),
        -2 if language == "en" || language == "fr" => Ok(-1),
        -2 => Ok(-2),
        _ => Err("지원하지 않는 속도 값입니다.".into()),
    }
}

#[derive(Deserialize)]
struct MakeIdResponse {
    id: String,
}

fn net_err(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "파파고 서버 응답이 너무 늦습니다. 잠시 후 다시 시도해 주세요.".into()
    } else if e.is_connect() {
        "파파고 서버에 연결할 수 없습니다. 인터넷 연결을 확인해 주세요.".into()
    } else {
        format!("네트워크 오류: {e}")
    }
}

async fn fetch_chunk(client: &Client, text: &str, speaker: &str, speed: i32) -> Result<Vec<u8>, String> {
    let speed = speed.to_string();
    let form = [
        ("alpha", "0"),
        ("pitch", "0"),
        ("speaker", speaker),
        ("speed", speed.as_str()),
        ("text", text),
    ];
    let res = client
        .post(format!("{API}/makeID"))
        .form(&form)
        .send()
        .await
        .map_err(net_err)?;

    let status = res.status();
    let content_type = res
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let body = res.text().await.map_err(net_err)?;
    if !status.is_success() || !content_type.contains("application/json") {
        return Err(format!(
            "파파고가 음성 ID를 주지 않았습니다 (HTTP {}). 파파고 사이트 구조가 바뀌었을 수 있습니다.",
            status.as_u16()
        ));
    }
    let id = serde_json::from_str::<MakeIdResponse>(&body)
        .map_err(|_| "파파고 응답 형식이 예상과 다릅니다. 사이트 구조가 바뀌었을 수 있습니다.".to_string())?
        .id;
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) {
        return Err("파파고가 알 수 없는 형식의 음성 ID를 보냈습니다.".into());
    }

    let res = client
        .get(format!("{API}/{id}"))
        .send()
        .await
        .map_err(net_err)?;
    if !res.status().is_success() {
        return Err(format!("음성 파일을 받지 못했습니다 (HTTP {}).", res.status().as_u16()));
    }
    let bytes = res.bytes().await.map_err(net_err)?;
    if bytes.is_empty() {
        return Err("빈 음성 파일을 받았습니다.".into());
    }
    Ok(bytes.to_vec())
}

/// 텍스트를 mp3 바이트로 만든다. 긴 글은 나눠 받아 하나로 이어 붙인다.
pub async fn synthesize(
    client: &Client,
    text: &str,
    language: &str,
    gender: &str,
    speed: i32,
) -> Result<Vec<u8>, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("읽을 텍스트가 비어 있습니다.".into());
    }
    if text.chars().count() > MAX_TOTAL_CHARS {
        return Err(format!("한 번에 {MAX_TOTAL_CHARS}자까지만 저장할 수 있습니다."));
    }
    let speaker = speaker(language, gender).ok_or("지원하지 않는 언어입니다.")?;
    let speed = normalize_speed(speed, language)?;

    let chunks = split_text(text, MAX_CHUNK_CHARS);
    let last = chunks.len().saturating_sub(1);
    let mut out = Vec::new();
    for (i, chunk) in chunks.iter().enumerate() {
        let data = fetch_chunk(client, chunk, speaker, speed)
            .await
            .map_err(|e| if chunks.len() > 1 { format!("{}/{} 조각: {e}", i + 1, chunks.len()) } else { e })?;
        let mut part: &[u8] = &data;
        if i > 0 {
            part = strip_id3v2(part);
        }
        if i < last {
            part = strip_id3v1(part);
        }
        out.extend_from_slice(part);
    }
    Ok(out)
}

// ---------- 긴 글 나누기 ----------

fn is_sentence_end(c: char) -> bool {
    matches!(c, '.' | '!' | '?' | '。' | '！' | '？' | '\n')
}

/// 문장 끝 문자 바로 뒤에서 자른 조각들 (구분 문자는 앞 조각에 남긴다).
fn sentences(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut prev_end = false;
    for (i, c) in text.char_indices() {
        if prev_end && !is_sentence_end(c) {
            out.push(&text[start..i]);
            start = i;
        }
        prev_end = is_sentence_end(c);
    }
    if start < text.len() {
        out.push(&text[start..]);
    }
    out
}

/// 한 문장이 너무 길면 공백 근처에서 강제로 자른다.
fn hard_split(s: &str, max: usize) -> Vec<String> {
    let chars: Vec<char> = s.chars().collect();
    let mut out = Vec::new();
    let mut pos = 0;
    while pos < chars.len() {
        let mut end = (pos + max).min(chars.len());
        if end < chars.len() {
            if let Some(ws) = (pos + max / 2..end).rev().find(|&k| chars[k].is_whitespace()) {
                end = ws + 1;
            }
        }
        out.push(chars[pos..end].iter().collect());
        pos = end;
    }
    out
}

pub fn split_text(text: &str, max: usize) -> Vec<String> {
    let mut chunks: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut cur_len = 0;

    for sentence in sentences(text) {
        let len = sentence.chars().count();
        if len > max {
            chunks.push(std::mem::take(&mut cur));
            cur_len = 0;
            chunks.extend(hard_split(sentence, max));
            continue;
        }
        if cur_len + len > max {
            chunks.push(std::mem::take(&mut cur));
            cur_len = 0;
        }
        cur.push_str(sentence);
        cur_len += len;
    }
    chunks.push(cur);

    chunks
        .into_iter()
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .collect()
}

// ---------- mp3 이어 붙이기 ----------

/// 맨 앞의 ID3v2 태그를 떼어 낸다 (두 번째 조각부터).
fn strip_id3v2(b: &[u8]) -> &[u8] {
    if b.len() >= 10 && &b[0..3] == b"ID3" {
        let size = ((b[6] as usize & 0x7f) << 21)
            | ((b[7] as usize & 0x7f) << 14)
            | ((b[8] as usize & 0x7f) << 7)
            | (b[9] as usize & 0x7f);
        let footer = if b[5] & 0x10 != 0 { 10 } else { 0 };
        let end = 10 + size + footer;
        if end <= b.len() {
            return &b[end..];
        }
    }
    b
}

/// 맨 뒤의 ID3v1 태그를 떼어 낸다 (마지막 조각 전까지).
fn strip_id3v1(b: &[u8]) -> &[u8] {
    let n = b.len();
    if n >= 128 && &b[n - 128..n - 125] == b"TAG" {
        &b[..n - 128]
    } else {
        b
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_text_is_one_chunk() {
        assert_eq!(split_text("안녕하세요. 반가워요!", 1000), vec!["안녕하세요. 반가워요!"]);
    }

    #[test]
    fn splits_at_sentence_boundaries() {
        let chunks = split_text("가나다. 라마바. 사아자.", 9);
        assert_eq!(chunks, vec!["가나다. 라마바.", "사아자."]);
        assert!(chunks.iter().all(|c| c.chars().count() <= 9));
    }

    #[test]
    fn hard_splits_long_sentence() {
        let long = "가".repeat(2500);
        let chunks = split_text(&long, 1000);
        assert_eq!(chunks.len(), 3);
        assert!(chunks.iter().all(|c| c.chars().count() <= 1000));
        assert_eq!(chunks.concat(), long);
    }

    #[test]
    fn keeps_all_text() {
        let text = "첫 문장입니다. 두 번째 문장! 세 번째?\n네 번째 줄";
        let joined: String = split_text(text, 12).concat();
        let strip = |s: &str| s.chars().filter(|c| !c.is_whitespace()).collect::<String>();
        assert_eq!(strip(&joined), strip(text));
    }

    #[test]
    fn strips_id3_tags() {
        let mut v2 = b"ID3\x03\x00\x00\x00\x00\x00\x05".to_vec();
        v2.extend_from_slice(b"xxxxxAUDIO");
        assert_eq!(strip_id3v2(&v2), b"AUDIO");

        let mut v1 = b"AUDIO".to_vec();
        v1.extend_from_slice(b"TAG");
        v1.extend(std::iter::repeat(0u8).take(125));
        assert_eq!(strip_id3v1(&v1), b"AUDIO");
    }

    /// 실제 파파고 서버에 요청한다: cargo test -- --ignored
    #[test]
    #[ignore = "실제 파파고 서버에 요청"]
    fn live_synthesize_long_text() {
        let client = build_client().unwrap();
        let text = "안녕하세요. 파파고 음성 저장 테스트입니다. ".repeat(50); // 1000자 넘음 → 2조각
        assert!(split_text(&text, MAX_CHUNK_CHARS).len() >= 2);
        let audio = tauri::async_runtime::block_on(synthesize(&client, &text, "ko", "female", 0)).unwrap();
        assert_eq!(&audio[0..3], b"ID3");
        assert!(audio.len() > 50_000, "너무 작음: {}", audio.len());
        let out = std::env::temp_dir().join("papago_live_test.mp3");
        std::fs::write(&out, &audio).unwrap();
        println!("saved {} bytes to {}", audio.len(), out.display());
    }

    #[test]
    fn speaker_table() {
        assert_eq!(speaker("ko", "female"), Some("kyuri"));
        assert_eq!(speaker("ko", "male"), Some("jinho"));
        assert_eq!(speaker("xx", "male"), None);
        assert_eq!(normalize_speed(-2, "en"), Ok(-1));
        assert_eq!(normalize_speed(-2, "ko"), Ok(-2));
        assert!(normalize_speed(7, "ko").is_err());
    }
}
