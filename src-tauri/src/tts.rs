//! 파파고 웹이 내부에서 쓰는 TTS 엔드포인트 호출.
//!
//! 1. POST /api/tts/makeID (폼: alpha, pitch, speaker, speed, text) -> {"id": "..."}
//! 2. GET  /api/tts/{id} -> audio/mpeg
//!
//! 비공식 엔드포인트라 파파고가 사이트를 바꾸면 예고 없이 동작하지 않을 수 있다.

use std::time::Duration;

use futures_util::stream::{self, StreamExt};
use reqwest::{header, Client};
use serde::Deserialize;

use crate::mp3;
use crate::subtitle::Cue;

const API: &str = "https://papago.naver.com/api/tts";

/// 파파고 웹이 한 번에 읽어 주는 최대 글자 수 (웹 코드의 TTS_MAX_TEXT_LENGTH).
/// 이보다 긴 글은 문장 단위로 나눠 받은 뒤 하나의 mp3로 이어 붙인다.
pub const MAX_CHUNK_CHARS: usize = 1000;

/// 자막을 만들 때 한 줄(자막 하나)의 최대 글자 수. 더 긴 문장은 공백 근처에서 나눈다.
pub const MAX_CUE_CHARS: usize = 120;

/// 한 번에 저장할 수 있는 최대 글자 수와 조각 수 (요청 폭주 방지).
pub const MAX_TOTAL_CHARS: usize = 20_000;
pub const MAX_PIECES: usize = 400;

/// 한 파일 안에서 동시에 보내는 요청 수
const PARALLEL: usize = 2;

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

pub struct Synth {
    pub audio: Vec<u8>,
    /// with_cues가 true일 때만 채워진다 (문장마다 하나)
    pub cues: Vec<Cue>,
}

/// 텍스트를 mp3로 만든다.
/// with_cues가 false면 1000자 단위로 받아 이어 붙이고,
/// true면 문장 단위로 받아 문장마다 시작·끝 시간을 기록한다 (자막용).
pub async fn synthesize(
    client: &Client,
    text: &str,
    language: &str,
    gender: &str,
    speed: i32,
    with_cues: bool,
) -> Result<Synth, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("읽을 텍스트가 비어 있습니다.".into());
    }
    if text.chars().count() > MAX_TOTAL_CHARS {
        return Err(format!("한 번에 {MAX_TOTAL_CHARS}자까지만 저장할 수 있습니다."));
    }
    let speaker = speaker(language, gender).ok_or("지원하지 않는 언어입니다.")?;
    let speed = normalize_speed(speed, language)?;

    let pieces = if with_cues {
        split_cues(text, MAX_CUE_CHARS)
    } else {
        split_text(text, MAX_CHUNK_CHARS)
    };
    if pieces.is_empty() {
        return Err("읽을 텍스트가 비어 있습니다.".into());
    }
    if pieces.len() > MAX_PIECES {
        return Err(format!(
            "문장이 너무 많습니다 ({}개). 한 파일에 {MAX_PIECES}문장까지 저장할 수 있습니다.",
            pieces.len()
        ));
    }

    let total = pieces.len();
    // 요청을 미리 만들어 두고 PARALLEL개씩 순서대로 보낸다 (결과 순서는 유지된다).
    let requests: Vec<_> = pieces.iter().map(|p| fetch_chunk(client, p, speaker, speed)).collect();
    let results: Vec<Result<Vec<u8>, String>> = stream::iter(requests).buffered(PARALLEL).collect().await;

    let mut audio = Vec::new();
    let mut cues = Vec::new();
    let mut time = 0.0;
    for (i, (piece, data)) in pieces.iter().zip(results).enumerate() {
        let data = data.map_err(|e| if total > 1 { format!("{}/{total} 조각: {e}", i + 1) } else { e })?;
        let tag_len = mp3::id3v2_len(&data);
        // 맨 앞 Info 프레임은 첫 문장 길이만 적혀 있어서 플레이어가 전체 길이를
        // 잘못 표시할 수 있으므로 항상 뺀다. (CBR이라 없어도 길이를 바르게 계산한다)
        let mut body = mp3::strip_info_frame(&data[tag_len..]);
        if i + 1 < total {
            body = mp3::strip_id3v1(body);
        }
        if i == 0 {
            audio.extend_from_slice(&data[..tag_len]);
        }
        audio.extend_from_slice(body);

        let duration = mp3::duration_secs(body);
        if with_cues {
            cues.push(Cue {
                start: time,
                end: time + duration,
                text: piece.split_whitespace().collect::<Vec<_>>().join(" "),
            });
        }
        time += duration;
    }
    Ok(Synth { audio, cues })
}

// ---------- 글 나누기 ----------

/// 문장 끝: 줄바꿈과 전각 문장부호는 바로 끊고,
/// . ! ? 는 뒤에 공백이 오거나 글이 끝날 때만 끊는다 (3.14, "...!" 같은 경우 보호).
fn sentences(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut iter = text.char_indices().peekable();
    while let Some((i, c)) = iter.next() {
        let next = iter.peek().map(|&(_, n)| n);
        let end_here = match c {
            '\n' | '。' | '！' | '？' => true,
            '.' | '!' | '?' => next.map_or(true, char::is_whitespace),
            _ => false,
        };
        if end_here {
            let end = i + c.len_utf8();
            out.push(&text[start..end]);
            start = end;
        }
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

/// 요청 단위로 나누기: 문장을 모아 max 글자 이하 조각으로 만든다.
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

/// 자막 단위로 나누기: 문장 하나가 자막 하나. 너무 긴 문장은 max 글자 근처에서 나눈다.
pub fn split_cues(text: &str, max: usize) -> Vec<String> {
    let mut out = Vec::new();
    for sentence in sentences(text) {
        let sentence = sentence.trim();
        if sentence.is_empty() {
            continue;
        }
        if sentence.chars().count() > max {
            out.extend(hard_split(sentence, max).into_iter().map(|s| s.trim().to_string()));
        } else {
            out.push(sentence.to_string());
        }
    }
    out.retain(|s| !s.is_empty());
    out
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
    fn cues_are_sentences() {
        assert_eq!(
            split_cues("원주율은 3.14입니다. 정말요?! 네…\n\n다음 줄입니다", 120),
            vec!["원주율은 3.14입니다.", "정말요?!", "네…", "다음 줄입니다"]
        );
        assert_eq!(split_cues("Hello. 世界。你好！", 120), vec!["Hello.", "世界。", "你好！"]);
    }

    #[test]
    fn long_cue_is_split() {
        let s = "가나다라 ".repeat(60); // 300자
        let cues = split_cues(&s, 120);
        assert!(cues.len() >= 3);
        assert!(cues.iter().all(|c| c.chars().count() <= 120));
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

    /// 실제 파파고 서버에 요청한다: cargo test -- --ignored
    #[test]
    #[ignore = "실제 파파고 서버에 요청"]
    fn live_synthesize_long_text() {
        let client = build_client().unwrap();
        let text = "안녕하세요. 파파고 음성 저장 테스트입니다. ".repeat(50); // 1000자 넘음 → 2조각
        assert!(split_text(&text, MAX_CHUNK_CHARS).len() >= 2);
        let s = tauri::async_runtime::block_on(synthesize(&client, &text, "ko", "female", 0, false)).unwrap();
        assert_eq!(&s.audio[0..3], b"ID3");
        assert!(s.audio.len() > 50_000, "너무 작음: {}", s.audio.len());
        let out = std::env::temp_dir().join("papago_live_test.mp3");
        std::fs::write(&out, &s.audio).unwrap();
        println!("saved {} bytes, {:.3}s to {}", s.audio.len(), mp3::duration_secs(&s.audio), out.display());
    }

    /// 자막: 문장마다 받아 이어 붙이고, 자막 시간과 전체 길이가 맞는지 본다.
    #[test]
    #[ignore = "실제 파파고 서버에 요청"]
    fn live_synthesize_with_cues() {
        let client = build_client().unwrap();
        let text = "안녕하세요. 만나서 반갑습니다.\n오늘 날씨가 정말 좋네요! 원주율은 3.14입니다.";
        let s = tauri::async_runtime::block_on(synthesize(&client, text, "ko", "female", 0, true)).unwrap();
        assert_eq!(s.cues.len(), 4);
        let total = mp3::duration_secs(&s.audio);
        assert!((s.cues.last().unwrap().end - total).abs() < 1e-6);
        for w in s.cues.windows(2) {
            assert!((w[0].end - w[1].start).abs() < 1e-9);
            assert!(w[0].end > w[0].start);
        }
        let dir = std::env::temp_dir();
        std::fs::write(dir.join("papago_cue_test.mp3"), &s.audio).unwrap();
        std::fs::write(dir.join("papago_cue_test.srt"), crate::subtitle::to_srt(&s.cues)).unwrap();
        println!("total {total:.3}s, cues {:?}", s.cues);
    }
}
